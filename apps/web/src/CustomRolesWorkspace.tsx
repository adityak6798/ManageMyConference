/**
 * Composing an event role, and seeing field by field what it would let somebody read and change.
 *
 * Issue #196's role/permission inspection screen and its preview-as-role tool, in one surface
 * because they are one question asked twice: the editor says what the role *is*, and the preview
 * says what that comes to once the subject-wide defaults and the required-field clamp are
 * resolved. Reading them apart is how somebody ships a role they believe hides a phone number.
 *
 * **Preview does not impersonate.** It asks the API what the stored role resolves to and renders
 * that. It never fetches a board "as" the role, which would run under the administrator's own
 * grants and show their data wearing the role's name.
 *
 * Nothing on this screen enforces anything. Every refusal it renders came from the API, and
 * every control it hides is a control the API would refuse anyway.
 *
 * Both the editor and the preview are drawers. They used to render as the third and fourth cards
 * below the table with no focus move, so on a normal viewport pressing Edit had no visible effect
 * whatsoever — the form it opened was below the fold, behind the portal locks.
 *
 * @spec PRD-IAM-002
 */
import { type FormEvent, useCallback, useMemo, useState } from "react";
import {
  assignCustomRole,
  createCustomRole,
  type CustomRoleDraft,
  type CustomRolePreview,
  type CustomRolesResponse,
  deleteCustomRole,
  listCustomRoles,
  previewCustomRole,
  setEventFieldLocks,
  unassignCustomRole,
  updateCustomRole,
} from "./api/custom-roles";
import { describeApiFailure } from "./api/config";
import { listMembers, type MembersResponse } from "./api/membership";
import "./styles/identity.css";
import { Checkbox, Select } from "./ui/fields";
import { IconMore, IconShield, IconSpeakers } from "./ui/icons";
import { Menu, type MenuEntry } from "./ui/menu";
import {
  Card,
  Drawer,
  EmptyState,
  LoadFailure,
  Pill,
  Section,
  SkeletonRows,
  useActionFeedback,
  useLoad,
} from "./ui/primitives";
import {
  type Capability,
  CAPABILITY_TERMS,
  capabilityLabel,
  groupCapabilities,
} from "./ui/vocabulary";

type Subject = "session" | "speaker" | "contact";
type Policy = "view" | "lock" | "hide";
type Template = CustomRoleDraft["template"];
type LockEntry = CustomRolesResponse["fieldLocks"][number];
type Role = CustomRolesResponse["roles"][number];
type Assignment = CustomRolesResponse["assignments"][number];

const POLICIES: readonly Policy[] = ["view", "lock", "hide"];
const POLICY_LABEL: Record<Policy, string> = {
  view: "View",
  lock: "View, cannot change",
  hide: "Hidden",
};
const SUBJECT_LABEL: Record<Subject, string> = {
  session: "Sessions",
  speaker: "Speakers",
  contact: "Contacts",
};

/*
 * The reference travels beside the sentence, never inside it.
 *
 * This used to answer "…could not be saved. Reference: 01JD…", which buries the one value the
 * reader is asked to quote in the one part of the message nobody reads character by character.
 * `Notice`, `LoadFailure` and `useActionFeedback` all take an `ApiFailure` and render its
 * reference as a selectable measure with its own copy control.
 */
const describe = (reason: unknown) =>
  describeApiFailure(
    reason,
    "Something went wrong. Please retry; if it continues, contact support.",
  );

/** Split out of a camelCase field name, these are initialisms rather than words. */
const INITIALISMS = new Set(["url", "id", "cfp", "ics", "api"]);

/**
 * `*` is the subject-wide default, and it is worth naming rather than printing the asterisk.
 *
 * Sentence case, not Title Case. Splitting `publicationState` on its capital and stopping there
 * produced "Publication State" — the one label on this grid in Title Case, sitting among "Every
 * other field", "Abstract" and "Tracks" — which is what made it read as a raw storage field
 * rather than as something an organizer decides about. Only the first word is capitalised now,
 * and a word that is an initialism goes up rather than down, so `photoUrl` is "Photo URL" and
 * not the "Photo url" a plain lowercasing would have printed.
 */
const fieldLabel = (field: string) =>
  field === "*"
    ? "Every other field"
    : field
        .replace(/Id$/, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .split(" ")
        .map((word, index) => {
          if (INITIALISMS.has(word.toLowerCase())) return word.toUpperCase();
          return index === 0
            ? word.replace(/^./, (first) => first.toUpperCase())
            : word.toLowerCase();
        })
        .join(" ");

const emptyDraft = (template: Template): CustomRoleDraft => ({
  name: "",
  description: "",
  template,
  capabilities: [],
  fieldPolicies: [],
});

export function CustomRolesWorkspace({
  organizationId,
  eventId,
  canManage,
}: {
  organizationId: string;
  eventId: string;
  /** Whether to render the write controls. The API refuses them regardless. */
  canManage: boolean;
}) {
  const { announce, node: feedback } = useActionFeedback();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<CustomRoleDraft | null>(null);
  const [expectedRevision, setExpectedRevision] = useState(0);
  const [preview, setPreview] = useState<CustomRolePreview | null>(null);
  /** `null` means "unedited": the stored set is what the screen shows until somebody changes it. */
  const [lockDraft, setLockDraft] = useState<LockEntry[] | null>(null);
  /** The role a deletion has been offered for, and the holder an unassignment has been. */
  const [deleting, setDeleting] = useState<Role | null>(null);
  const [unassigning, setUnassigning] = useState<{ role: Role; holder: Assignment } | null>(null);

  const scope = useMemo(() => ({ organizationId, eventId }), [organizationId, eventId]);
  const roles = useLoad<typeof scope, CustomRolesResponse>(
    scope,
    useCallback((key: typeof scope) => listCustomRoles(key.organizationId, key.eventId), []),
    describe,
  );
  const members = useLoad<string, MembersResponse>(
    organizationId,
    useCallback((id: string) => listMembers(id), []),
    describe,
  );

  const run = async (what: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await roles.reload();
      announce("success", what);
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  };

  if (roles.error)
    return (
      <LoadFailure
        what="the custom roles"
        error={roles.error}
        reference={roles.reference}
        onRetry={roles.reload}
      />
    );
  const data = roles.data;
  if (!data)
    return (
      <Card>
        <SkeletonRows rows={3} label="Loading the custom roles" />
      </Card>
    );

  const startNew = (template: Template) => {
    const chosen = data.templates.find((entry) => entry.key === template);
    setEditing("new");
    setExpectedRevision(0);
    setDraft({
      ...emptyDraft(template),
      name: chosen?.label ?? "",
      description: chosen?.description ?? "",
      capabilities: [...(chosen?.capabilities ?? [])],
      fieldPolicies: (chosen?.fieldPolicies ?? []).map((entry) => ({ ...entry })),
    });
  };

  const startEdit = (roleId: string) => {
    const role = data.roles.find((entry) => entry.id === roleId);
    if (!role) return;
    setEditing(roleId);
    setExpectedRevision(role.revision);
    setDraft({
      name: role.name,
      description: role.description,
      template: role.template,
      capabilities: [...role.capabilities],
      fieldPolicies: role.fieldPolicies.map((entry) => ({ ...entry })),
    });
  };

  const closeEditor = () => {
    setDraft(null);
    setEditing(null);
  };

  const setPolicy = (subject: Subject, field: string, policy: Policy) =>
    setDraft((current) => {
      if (!current) return current;
      const others = current.fieldPolicies.filter(
        (entry) => !(entry.subject === subject && entry.field === field),
      );
      // `view` is the absence of a policy; the service drops it too, so the two agree about what
      // an unchanged field means.
      return {
        ...current,
        fieldPolicies: policy === "view" ? others : [...others, { subject, field, policy }],
      };
    });

  const storedLocks = data.fieldLocks;
  const locks = lockDraft ?? storedLocks;
  const lockOf = (subject: Subject, field: string): Policy =>
    (locks.find((entry) => entry.subject === subject && entry.field === field)?.policy as Policy) ??
    "view";
  const setLock = (subject: Subject, field: string, policy: Policy) =>
    setLockDraft((current) => {
      const others = (current ?? storedLocks).filter(
        (entry) => !(entry.subject === subject && entry.field === field),
      );
      return policy === "view" ? others : [...others, { subject, field, policy }];
    });

  const policyOf = (subject: Subject, field: string): Policy =>
    draft?.fieldPolicies.find((entry) => entry.subject === subject && entry.field === field)
      ?.policy ?? "view";

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (!draft) return;
    const saving = editing;
    await run(saving === "new" ? "Role created." : "Role updated.", async () => {
      if (saving === "new") await createCustomRole(organizationId, eventId, draft);
      else if (saving)
        await updateCustomRole(organizationId, eventId, saving, { ...draft, expectedRevision });
      setEditing(null);
      setDraft(null);
    });
  }

  const holdersOf = (roleId: string) =>
    data.assignments.filter((assignment) => assignment.roleId === roleId);

  const openPreview = async (roleId: string) => {
    try {
      setPreview(await previewCustomRole(organizationId, eventId, roleId));
    } catch (reason) {
      announce("error", describe(reason));
    }
  };

  return (
    <div className="members">
      {feedback}

      <Section
        title="Custom roles"
        description="A role narrows what its holder may see and change, field by field. It can never administer roles."
        actions={
          canManage && data.roles.length > 0 ? (
            <Menu
              label="Start a new role from a template"
              trigger="New role"
              triggerClassName="primary small"
              align="end"
              disabled={busy}
              items={data.templates.map((template) => ({
                id: template.key,
                label: template.label,
                hint: template.description,
                onSelect: () => startNew(template.key),
              }))}
            />
          ) : null
        }
      >
        {data.roles.length === 0 ? (
          <EmptyState
            icon={<IconShield size={20} />}
            title="No custom roles yet"
            action={
              canManage ? (
                <fieldset className="role-template-grid">
                  <legend className="visually-hidden">Role templates</legend>
                  {data.templates.map((template) => (
                    <button
                      key={template.key}
                      type="button"
                      className="role-template-card secondary"
                      disabled={busy}
                      onClick={() => startNew(template.key)}
                    >
                      <strong>{template.label}</strong>
                      <span>Use as a starting point</span>
                    </button>
                  ))}
                </fieldset>
              ) : null
            }
          >
            Start from a template, then narrow it. A template is a starting point; every capability
            is checked against the allowlist regardless of what the template said.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <caption className="visually-hidden">Custom roles on this event</caption>
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">May do</th>
                  <th scope="col">Holders</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.roles.map((role) => {
                  const items: MenuEntry[] = [
                    {
                      id: "preview",
                      label: "Preview as this role",
                      hint: "What it resolves to. Nothing is read on its behalf.",
                      onSelect: () => {
                        // ERROR-INTENT: handlers cannot await; openPreview announces its failure.
                        void openPreview(role.id);
                      },
                    },
                  ];
                  if (canManage)
                    items.push(
                      { id: "edit", label: "Edit role", onSelect: () => startEdit(role.id) },
                      { id: "separator", separator: true },
                      {
                        id: "delete",
                        label: "Delete role",
                        danger: true,
                        hint: "Asks first. Everybody holding it loses that access.",
                        onSelect: () => setDeleting(role),
                      },
                    );
                  return (
                    <tr key={role.id}>
                      <td className="primary-cell" data-label="Role">
                        {role.name}
                        {role.description ? <span className="sub">{role.description}</span> : null}
                      </td>
                      {/*
                        The role's capabilities in the product's own words rather than as wire
                        tokens: `crm:manage` beside `reports:pii` told a reader nothing about
                        which of the two hands over unmasked personal data.
                      */}
                      <td data-label="May do">
                        <span className="capability-chips">
                          {role.capabilities.map((capability) => (
                            <Pill
                              key={capability}
                              tone={
                                CAPABILITY_TERMS[capability as Capability]?.sensitive
                                  ? "warn"
                                  : "info"
                              }
                            >
                              {capabilityLabel(capability)}
                            </Pill>
                          ))}
                        </span>
                      </td>
                      <td data-label="Holders">
                        {holdersOf(role.id).length === 0 ? (
                          <span className="hint">Nobody yet</span>
                        ) : (
                          holdersOf(role.id).map((assignment) => (
                            <span key={assignment.userId} className="holder">
                              {assignment.userName}
                              {canManage ? (
                                <button
                                  className="danger small"
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setUnassigning({ role, holder: assignment })}
                                >
                                  Remove
                                  <span className="visually-hidden">
                                    {" "}
                                    {assignment.userName} from {role.name}
                                  </span>
                                </button>
                              ) : null}
                            </span>
                          ))
                        )}
                      </td>
                      <td data-label="Actions">
                        {/*
                          One menu per row rather than three buttons of equal weight, so Delete
                          is a deliberate second press instead of a neighbour of Preview.
                        */}
                        <Menu
                          label={`Actions for ${role.name}`}
                          trigger={<IconMore size={20} />}
                          triggerClassName="ghost small"
                          align="end"
                          disabled={busy}
                          items={items}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/*
       * Portal locks, beside the roles, because an organizer asking "can this speaker still change
       * their bio?" should not have to know which of the two mechanisms answers.
       *
       * They are a different thing from a role's field policy and the copy says so: a role policy
       * governs somebody staffed onto the event, and a lock governs the person whose record it is.
       * A speaker holds no role, so nothing in the roles table above could ever have closed their
       * own portal — which is why the write surface used to be fixed in code (issue #189's
       * `GAP-028`) rather than configured per event.
       */}
      <Section
        title="Portal field locks"
        description="What the person whose record it is may still change on their own portal. Locking is per event."
        actions={
          canManage ? (
            <>
              <button
                className="primary"
                type="button"
                disabled={busy || lockDraft === null}
                onClick={() =>
                  run("Portal field locks saved.", async () => {
                    await setEventFieldLocks(organizationId, eventId, locks);
                    setLockDraft(null);
                  })
                }
              >
                Save portal locks
              </button>
              <button
                className="secondary"
                type="button"
                disabled={busy || lockDraft === null}
                onClick={() => setLockDraft(null)}
              >
                Discard changes
              </button>
            </>
          ) : null
        }
      >
        <div className="portal-lock-groups">
          {data.catalogue.map((subject, subjectIndex) => (
            <details key={subject.subject} open={subjectIndex === 0}>
              <summary>
                <span>{SUBJECT_LABEL[subject.subject as Subject]}</span>
                <span className="sub">Choose what owners can update</span>
              </summary>
              {/*
                The one select set on this surface that stays native.

                `<fieldset disabled>` disables every native form control inside it in one
                declaration, and a reader without `identity:manage` sees this whole grid closed
                by that single attribute. A button-based listbox is not a form control the
                fieldset owns, so replacing these would mean threading `disabled` through every
                one of them by hand — a rule that is currently impossible to get wrong, made
                possible to get wrong, on the grid that decides what a speaker may edit about
                themselves. The acceptance test for it reads these elements' own `options`.
              */}
              <fieldset className="portal-lock-grid" disabled={!canManage}>
                <legend className="visually-hidden">
                  {SUBJECT_LABEL[subject.subject as Subject]} fields
                </legend>
                {subject.fields.map((entry) => (
                  <label key={entry.field}>
                    <span>{fieldLabel(entry.field)}</span>
                    <select
                      className="control"
                      value={lockOf(subject.subject as Subject, entry.field)}
                      onChange={(changed) =>
                        setLock(
                          subject.subject as Subject,
                          entry.field,
                          changed.target.value as Policy,
                        )
                      }
                    >
                      {POLICIES.filter((policy) => !(entry.required && policy === "hide")).map(
                        (policy) => (
                          <option key={policy} value={policy}>
                            {POLICY_LABEL[policy]}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                ))}
              </fieldset>
            </details>
          ))}
        </div>
      </Section>

      {canManage && data.roles.length > 0 ? (
        <Section
          title="Give somebody a role"
          description="A custom role staffs a member of this organization, and a person holds at most one on an event."
        >
          <AssignForm
            busy={busy}
            roles={data.roles.map(({ id, name }) => ({ id, name }))}
            members={(members.data?.members ?? []).map(({ userId, name }) => ({
              userId,
              name,
            }))}
            onAssign={(roleId, userId, label) =>
              run(`Granted ${label}.`, () =>
                assignCustomRole(organizationId, eventId, roleId, userId),
              )
            }
          />
        </Section>
      ) : null}

      <Drawer
        open={draft !== null}
        title={editing === "new" ? "New role" : "Edit role"}
        description="Hidden fields are removed from every projection, export and report — not blanked."
        busy={busy}
        onClose={closeEditor}
        footer={
          <>
            <button className="primary" type="submit" form="role-editor-form" disabled={busy}>
              {editing === "new" ? "Create role" : "Save changes"}
            </button>
            <button className="secondary" type="button" disabled={busy} onClick={closeEditor}>
              Cancel
            </button>
          </>
        }
      >
        {draft ? (
          <form id="role-editor-form" onSubmit={submit} className="role-drawer">
            <label>
              Name
              <input
                className="control"
                required
                maxLength={80}
                value={draft.name}
                onChange={(changed) => setDraft({ ...draft, name: changed.target.value })}
              />
            </label>
            <label>
              Description
              <input
                className="control"
                maxLength={400}
                value={draft.description ?? ""}
                onChange={(changed) => setDraft({ ...draft, description: changed.target.value })}
              />
            </label>
            {/*
              Every capability reads as a decision: what it is called, what granting it lets
              somebody do, and the wire token dimmed at the end for whoever is matching this
              against an API client. The consequence sentences are `ui/vocabulary.ts`'s, so the
              same grant is described the same way here and on the API-client form.
            */}
            <fieldset className="capability-groups">
              <legend className="visually-hidden">Capabilities</legend>
              {groupCapabilities(data.grantableCapabilities).map((group) => (
                <div key={group.title} className="capability-group">
                  <h4>{group.title}</h4>
                  {group.scopes.map((capability) => {
                    const term = CAPABILITY_TERMS[capability];
                    return (
                      <Checkbox
                        key={capability}
                        label={capabilityLabel(capability)}
                        checked={draft.capabilities.includes(capability)}
                        hint={
                          <>
                            {term?.sensitive ? <Pill tone="warn">Personal data</Pill> : null}{" "}
                            {term?.consequence ?? "Granted as the API defines it."}{" "}
                            <span className="capability-token">{capability}</span>
                          </>
                        }
                        onChange={(checked) =>
                          setDraft({
                            ...draft,
                            capabilities: checked
                              ? [...draft.capabilities, capability]
                              : draft.capabilities.filter((held) => held !== capability),
                          })
                        }
                      />
                    );
                  })}
                </div>
              ))}
              <p className="hint">
                Administering roles is deliberately not on this list: a role that could grant
                capabilities could grant itself the ones withheld here.
              </p>
            </fieldset>
            {data.catalogue.map((subject) => (
              <fieldset key={subject.subject} className="role-field-grid">
                <legend>{SUBJECT_LABEL[subject.subject as Subject]}</legend>
                {/* The shared listbox. Nothing here reads the native element — the policy is
                    state, and the clamp below is a filter over the options — so this is one of
                    the surfaces the control tier was written to reach. */}
                {subject.fields.map((entry) => (
                  <Select
                    key={entry.field}
                    label={fieldLabel(entry.field)}
                    value={policyOf(subject.subject as Subject, entry.field)}
                    onChange={(policy) =>
                      setPolicy(subject.subject as Subject, entry.field, policy as Policy)
                    }
                    options={POLICIES.filter(
                      // A record with no identifying field is unjoinable, so the control does
                      // not offer a Hide the service would refuse.
                      (policy) => !(entry.required && policy === "hide"),
                    ).map((policy) => ({ value: policy, label: POLICY_LABEL[policy] }))}
                  />
                ))}
              </fieldset>
            ))}
          </form>
        ) : null}
      </Drawer>

      <Drawer
        open={preview !== null}
        title={preview ? `Preview: ${preview.role.name}` : "Preview"}
        description="What this role resolves to. Nothing was read on its behalf."
        onClose={() => setPreview(null)}
        footer={
          <button className="secondary" type="button" onClick={() => setPreview(null)}>
            Close preview
          </button>
        }
      >
        {preview ? (
          <div className="role-drawer">
            <div>
              <h3>May do</h3>
              <span className="capability-chips">
                {preview.capabilities.map((capability) => (
                  <Pill
                    key={capability}
                    tone={CAPABILITY_TERMS[capability as Capability]?.sensitive ? "warn" : "info"}
                  >
                    {capabilityLabel(capability)}
                  </Pill>
                ))}
              </span>
            </div>
            <div className="table-wrap">
              <table className="data">
                <caption className="visually-hidden">Resolved field access for this role</caption>
                <thead>
                  <tr>
                    <th scope="col">Record</th>
                    <th scope="col">Field</th>
                    <th scope="col">Access</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.fields.map((entry) => (
                    <tr key={`${entry.subject}:${entry.field}`}>
                      <td data-label="Record">{SUBJECT_LABEL[entry.subject as Subject]}</td>
                      <td data-label="Field">{fieldLabel(entry.field)}</td>
                      <td data-label="Access">
                        <Pill
                          tone={
                            entry.policy === "hide"
                              ? "warn"
                              : entry.policy === "lock"
                                ? "neutral"
                                : "ok"
                          }
                        >
                          {POLICY_LABEL[entry.policy as Policy]}
                        </Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </Drawer>

      {/*
        Deleting a role strips access from everybody listed two columns to its left, and it used
        to do that on one press of a button beside Edit. The drawer names the role and counts the
        holders, because that count is the whole consequence.
      */}
      <Drawer
        open={deleting !== null}
        title={deleting ? `Delete “${deleting.name}”?` : "Delete role"}
        description="A deleted role cannot be restored, and its holders lose what it granted."
        busy={busy}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button
              className="danger primary"
              type="button"
              disabled={busy}
              onClick={() => {
                const role = deleting;
                if (!role) return;
                setDeleting(null);
                // ERROR-INTENT: handlers cannot await; `run` announces its own failure.
                void run(`Deleted ${role.name}.`, () =>
                  deleteCustomRole(organizationId, eventId, role.id, role.revision),
                );
              }}
            >
              Delete role
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              Keep it
            </button>
          </>
        }
      >
        {deleting ? (
          <div className="stack">
            <p>
              {holdersOf(deleting.id).length === 0
                ? "Nobody holds this role, so nobody loses access today."
                : `${holdersOf(deleting.id).length} ${holdersOf(deleting.id).length === 1 ? "person holds" : "people hold"} this role and will lose what it granted:`}
            </p>
            {holdersOf(deleting.id).length > 0 ? (
              <ul className="plain-list">
                {holdersOf(deleting.id).map((assignment) => (
                  <li key={assignment.userId}>{assignment.userName}</li>
                ))}
              </ul>
            ) : null}
            <p className="hint">
              They keep any organizer, reviewer or speaker role they hold; only what this role
              granted goes.
            </p>
          </div>
        ) : null}
      </Drawer>

      <Drawer
        open={unassigning !== null}
        title={
          unassigning
            ? `Take “${unassigning.role.name}” from ${unassigning.holder.userName}?`
            : "Remove holder"
        }
        busy={busy}
        onClose={() => setUnassigning(null)}
        footer={
          <>
            <button
              className="danger primary"
              type="button"
              disabled={busy}
              onClick={() => {
                const target = unassigning;
                if (!target) return;
                setUnassigning(null);
                // ERROR-INTENT: handlers cannot await; `run` announces its own failure.
                void run(`Removed ${target.holder.userName} from ${target.role.name}.`, () =>
                  unassignCustomRole(organizationId, eventId, target.role.id, target.holder.userId),
                );
              }}
            >
              Take the role back
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => setUnassigning(null)}
            >
              Leave it with them
            </button>
          </>
        }
      >
        {unassigning ? (
          <p>
            {unassigning.holder.userName} loses everything “{unassigning.role.name}” grants on this
            event, immediately. Give it back from “Give somebody a role” below the table.
          </p>
        ) : null}
      </Drawer>
    </div>
  );
}

function AssignForm({
  busy,
  roles,
  members,
  onAssign,
}: {
  busy: boolean;
  roles: readonly { id: string; name: string }[];
  members: readonly { userId: string; name: string }[];
  onAssign: (roleId: string, userId: string, label: string) => void;
}) {
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [userId, setUserId] = useState(members[0]?.userId ?? "");
  if (members.length === 0)
    return (
      <EmptyState icon={<IconSpeakers size={20} />} title="Nobody to staff yet">
        Invite somebody to the organization first; a role staffs a member rather than a stranger.
      </EmptyState>
    );
  return (
    <form
      className="stack"
      onSubmit={(formEvent) => {
        formEvent.preventDefault();
        const role = roles.find((entry) => entry.id === roleId);
        const member = members.find((entry) => entry.userId === userId);
        if (role && member)
          onAssign(role.id, member.userId, `${member.name} the ${role.name} role`);
      }}
    >
      {/* Both are the shared listbox: neither depends on the native element, and the assign form
          used to be the last place on this surface drawing operating-system chevrons beside
          product-drawn controls. */}
      <Select
        label="Role"
        value={roleId}
        onChange={setRoleId}
        options={roles.map((role) => ({ value: role.id, label: role.name }))}
      />
      <Select
        label="Member"
        value={userId}
        onChange={setUserId}
        options={members.map((member) => ({ value: member.userId, label: member.name }))}
      />
      <button className="primary" type="submit" disabled={busy}>
        Grant role
      </button>
    </form>
  );
}
