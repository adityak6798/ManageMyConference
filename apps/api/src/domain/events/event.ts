export interface Event {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly timezone: string;
  readonly createdAt: string;
}

export interface Organization {
  readonly id: string;
  readonly name: string;
}
