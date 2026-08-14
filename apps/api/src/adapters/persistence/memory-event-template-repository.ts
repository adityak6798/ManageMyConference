import type {
  EventTemplateApplicationRecord,
  EventTemplateApplicationView,
  EventTemplateRepository,
  EventTemplateVersionDraft,
} from "../../application/events/event-template-repository";
import { EventTemplateNameTakenError } from "../../application/events/event-template-service";
import type {
  EventTemplate,
  EventTemplateState,
  EventTemplateVersion,
} from "../../domain/events/event-template";

/**
 * The in-memory twin of `D1EventTemplateRepository`, for service-level tests.
 *
 * It enforces the same invariants the migration and the adapter do — one active name per
 * organization, one row per `(event, template version)`, a version number allocated by the store
 * rather than by its caller, and no template without a first version — because a double that
 * accepts what the database refuses turns a real defect into a green test.
 */
export class MemoryEventTemplateRepository implements EventTemplateRepository {
  private readonly templates = new Map<string, EventTemplate>();
  private readonly versions: EventTemplateVersion[] = [];
  private readonly applications = new Map<string, EventTemplateApplicationRecord>();

  /**
   * Both rows or neither, which is what D1's batch gives the real adapter.
   *
   * The name check is the only thing that can refuse here and it runs before either write, so a
   * refused save leaves no husk behind — the property issue #177 is about.
   */
  async createTemplateWithVersion(
    template: EventTemplate,
    version: EventTemplateVersionDraft,
  ): Promise<number> {
    this.assertNameFree(template.organizationId, template.name, template.id);
    this.templates.set(template.id, template);
    return this.appendVersion(version);
  }

  async findTemplate(templateId: string): Promise<EventTemplate | null> {
    return this.templates.get(templateId) ?? null;
  }

  async listTemplates(organizationId: string): Promise<readonly EventTemplate[]> {
    return [...this.templates.values()]
      .filter((template) => template.organizationId === organizationId)
      .sort(
        (left, right) =>
          left.state.localeCompare(right.state) || left.name.localeCompare(right.name),
      );
  }

  async updateTemplate(
    templateId: string,
    changes: { readonly name?: string; readonly state?: EventTemplateState },
    updatedAt: string,
  ): Promise<boolean> {
    const template = this.templates.get(templateId);
    if (!template) return false;
    const updated: EventTemplate = { ...template, ...changes, updatedAt };
    if (updated.state === "active")
      this.assertNameFree(updated.organizationId, updated.name, templateId);
    this.templates.set(templateId, updated);
    return true;
  }

  async createVersion(version: EventTemplateVersionDraft): Promise<number> {
    // The adapter's `WHERE EXISTS` guard, stated the way this store can state it: no version
    // without the template it points at.
    if (!this.templates.has(version.templateId))
      throw new Error(`No template ${version.templateId} to append a version to`);
    return this.appendVersion(version);
  }

  private appendVersion(version: EventTemplateVersionDraft): number {
    const allocated =
      this.versions
        .filter((existing) => existing.templateId === version.templateId)
        .reduce((highest, existing) => Math.max(highest, existing.version), 0) + 1;
    // Round-tripped so a caller cannot mutate a stored payload through the object it passed in,
    // which the database would never allow either.
    this.versions.push({
      ...version,
      version: allocated,
      payload: JSON.parse(JSON.stringify(version.payload)),
    });
    return allocated;
  }

  async findVersion(templateId: string, version: number): Promise<EventTemplateVersion | null> {
    return (
      this.versions.find(
        (candidate) => candidate.templateId === templateId && candidate.version === version,
      ) ?? null
    );
  }

  async listVersions(templateId: string): Promise<readonly EventTemplateVersion[]> {
    return this.versions
      .filter((version) => version.templateId === templateId)
      .sort((left, right) => right.version - left.version);
  }

  async recordApplication(application: EventTemplateApplicationRecord): Promise<void> {
    this.applications.set(`${application.eventId}:${application.templateVersionId}`, application);
  }

  async listApplications(eventId: string): Promise<readonly EventTemplateApplicationView[]> {
    return [...this.applications.values()]
      .filter((application) => application.eventId === eventId)
      .sort((left, right) => right.appliedAt.localeCompare(left.appliedAt))
      .flatMap((application) => {
        const version = this.versions.find(({ id }) => id === application.templateVersionId);
        const template = version ? this.templates.get(version.templateId) : undefined;
        return version && template
          ? [
              {
                templateId: template.id,
                templateName: template.name,
                templateState: template.state,
                templateVersionId: version.id,
                version: version.version,
                appliedAt: application.appliedAt,
                appliedBy: application.appliedBy,
                ...application.outcome,
              },
            ]
          : [];
      });
  }

  private assertNameFree(organizationId: string, name: string, exceptTemplateId: string): void {
    const taken = [...this.templates.values()].some(
      (template) =>
        template.id !== exceptTemplateId &&
        template.state === "active" &&
        template.organizationId === organizationId &&
        template.name === name,
    );
    if (taken)
      throw new EventTemplateNameTakenError(
        "Another active template in this organization already uses that name",
      );
  }

  reset(): void {
    this.templates.clear();
    this.versions.length = 0;
    this.applications.clear();
  }
}
