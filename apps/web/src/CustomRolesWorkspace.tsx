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
 * @spec PRD-IAM-002
 */
import { type FormEvent, useCallback, useMemo, useState } from "react";
import {
  assignCustomRole,
  createCustomRole,
  CustomRoleApiError,
  type CustomRoleDraft,
  type CustomRolePreview,
  type CustomRolesResponse,
  deleteCustomRole,
  listCustomRoles,
  previewCustomRole,
  unassignCustomRole,
  updateCustomRole,
} from "./api/custom-roles";
import { listMembers, type MembersResponse } from "./api/membership";
import "./styles/identity.css";
import { Card, EmptyState, Notice, Pill, useActionFeedback, useLoad } from "./ui/primitives";

type Subject = "session" | "speaker" | "contact";
type Policy = "view" | "lock" | "hide";
type Template = CustomRoleDraft["template"];

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

const describe = (reason: unknown) =>
  reason instanceof CustomRoleApiError
    ? `${reason.message} Reference: ${reason.correlationId}`
    : "Something went wrong. Please retry; if it continues, contact support.";

/** `*` is the subject-wide default, and it is worth naming rather than printing the asterisk. */
const fieldLabel = (field: string) => (field === "*" ? "Every other field" : field);

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

  if (roles.loading && !roles.data) return <Card>Loading roles…</Card>;
  if (roles.error) return <Notice tone="error">{roles.error}</Notice>;
  const data = roles.data;
  if (!data) return <Card>Loading roles…</Card>;

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

  return (
    <div className="members">
      {feedback}

      <Card
        title="Custom roles"
        hint="A role narrows what its holder may see and change, field by field. It can never administer roles."
      >
        {data.roles.length === 0 ? (
          <EmptyState title="No custom roles yet">
            Start from a template, then narrow it. A template is a starting point; every capability
            is checked against the allowlist regardless of what the template said.
          </EmptyState>
        ) : (
          <table>
            <caption className="visually-hidden">Custom roles on this event</caption>
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Capabilities</th>
                <th scope="col">Holders</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.roles.map((role) => (
                <tr key={role.id}>
                  <td className="primary-cell" data-label="Role">
                    {role.name}
                    {role.description ? <span className="sub">{role.description}</span> : null}
                  </td>
                  <td data-label="Capabilities">
                    {role.capabilities.map((capability) => (
                      <Pill key={capability} tone="info">
                        {capability}
                      </Pill>
                    ))}
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
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                run(`Removed ${assignment.userName} from ${role.name}.`, () =>
                                  unassignCustomRole(
                                    organizationId,
                                    eventId,
                                    role.id,
                                    assignment.userId,
                                  ),
                                )
                              }
                            >
                              Remove
                            </button>
                          ) : null}
                        </span>
                      ))
                    )}
                  </td>
                  <td data-label="Actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        try {
                          setPreview(await previewCustomRole(organizationId, eventId, role.id));
                        } catch (reason) {
                          announce("error", describe(reason));
                        }
                      }}
                    >
                      Preview as this role
                    </button>
                    {canManage ? (
                      <>
                        <button type="button" disabled={busy} onClick={() => startEdit(role.id)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            run(`Deleted ${role.name}.`, () =>
                              deleteCustomRole(organizationId, eventId, role.id, role.revision),
                            )
                          }
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canManage ? (
          <div className="actions">
            {data.templates.map((template) => (
              <button
                key={template.key}
                type="button"
                disabled={busy}
                onClick={() => startNew(template.key)}
              >
                New from “{template.label}”
              </button>
            ))}
          </div>
        ) : null}
      </Card>

      {draft ? (
        <Card
          title={editing === "new" ? "New role" : "Edit role"}
          hint="Hidden fields are removed from every projection, export and report — not blanked."
        >
          <form onSubmit={submit} className="stack">
            <label>
              Name
              <input
                required
                maxLength={80}
                value={draft.name}
                onChange={(changed) => setDraft({ ...draft, name: changed.target.value })}
              />
            </label>
            <label>
              Description
              <input
                maxLength={400}
                value={draft.description ?? ""}
                onChange={(changed) => setDraft({ ...draft, description: changed.target.value })}
              />
            </label>
            <fieldset>
              <legend>Capabilities</legend>
              {data.grantableCapabilities.map((capability) => (
                <label key={capability} className="inline">
                  <input
                    type="checkbox"
                    checked={draft.capabilities.includes(capability)}
                    onChange={(changed) =>
                      setDraft({
                        ...draft,
                        capabilities: changed.target.checked
                          ? [...draft.capabilities, capability]
                          : draft.capabilities.filter((held) => held !== capability),
                      })
                    }
                  />
                  {capability}
                </label>
              ))}
              <p className="hint">
                Administering roles is deliberately not on this list: a role that could grant
                capabilities could grant itself the ones withheld here.
              </p>
            </fieldset>
            {data.catalogue.map((subject) => (
              <fieldset key={subject.subject}>
                <legend>{SUBJECT_LABEL[subject.subject as Subject]}</legend>
                {subject.fields.map((entry) => (
                  <label key={entry.field}>
                    {fieldLabel(entry.field)}
                    <select
                      value={policyOf(subject.subject as Subject, entry.field)}
                      onChange={(changed) =>
                        setPolicy(
                          subject.subject as Subject,
                          entry.field,
                          changed.target.value as Policy,
                        )
                      }
                    >
                      {POLICIES.filter(
                        // A record with no identifying field is unjoinable, so the control does
                        // not offer a Hide the service would refuse.
                        (policy) => !(entry.required && policy === "hide"),
                      ).map((policy) => (
                        <option key={policy} value={policy}>
                          {POLICY_LABEL[policy]}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </fieldset>
            ))}
            <div className="actions">
              <button type="submit" disabled={busy}>
                {editing === "new" ? "Create role" : "Save changes"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setEditing(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </Card>
      ) : null}

      {preview ? (
        <Card
          title={`Preview: ${preview.role.name}`}
          hint="What this role resolves to. Nothing was read on its behalf."
          actions={
            <button type="button" onClick={() => setPreview(null)}>
              Close preview
            </button>
          }
        >
          <p>
            Capabilities:{" "}
            {preview.capabilities.map((capability) => (
              <Pill key={capability} tone="info">
                {capability}
              </Pill>
            ))}
          </p>
          <table>
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
                  <td data-label="Field">{entry.field}</td>
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
        </Card>
      ) : null}

      {canManage && data.roles.length > 0 ? (
        <Card
          title="Give somebody a role"
          hint="A custom role staffs a member of this organization, and a person holds at most one on an event."
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
        </Card>
      ) : null}
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
      <EmptyState title="Nobody to staff yet">
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
      <label>
        Role
        <select value={roleId} onChange={(changed) => setRoleId(changed.target.value)}>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Member
        <select value={userId} onChange={(changed) => setUserId(changed.target.value)}>
          {members.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={busy}>
        Grant role
      </button>
    </form>
  );
}
