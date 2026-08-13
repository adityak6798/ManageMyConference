import type {
  EventTemplateApplicationRecord,
  EventTemplateApplicationView,
  EventTemplateRepository,
  EventTemplateVersionRecord,
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
 * It enforces the same two invariants the migration does — one active name per organization,
 * one row per `(event, template version)` — because a double that accepts what the database
 * refuses turns a real defect into a green test.
 */
export class MemoryEventTemplateRepository implements EventTemplateRepository {
  private readonly templates = new Map<string, EventTemplate>();
  private readonly versions: EventTemplateVersion[] = [];
  private readonly applications = new Map<string, EventTemplateApplicationRecord>();

  async createTemplate(template: EventTemplate): Promise<void> {
    this.assertNameFree(template.organizationId, template.name, template.id);
    this.templates.set(template.id, template);
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

  async nextVersion(templateId: string): Promise<number> {
    return (
      this.versions
        .filter((version) => version.templateId === templateId)
        .reduce((highest, version) => Math.max(highest, version.version), 0) + 1
    );
  }

  async createVersion(version: EventTemplateVersionRecord): Promise<void> {
    if (
      this.versions.some(
        (existing) =>
          existing.templateId === version.templateId && existing.version === version.version,
      )
    )
      throw new Error(`Template ${version.templateId} already has version ${version.version}`);
    // Round-tripped so a caller cannot mutate a stored payload through the object it passed in,
    // which the database would never allow either.
    this.versions.push({ ...version, payload: JSON.parse(JSON.stringify(version.payload)) });
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
                templateVersionId: version.id,
                version: version.version,
                appliedAt: application.appliedAt,
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
