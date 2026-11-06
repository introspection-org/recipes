/**
 * The parts of Microsoft Graph v1.0 resources this package reads and writes,
 * written by hand from the resource types in `microsoftgraph/msgraph-metadata`
 * (`openapi/v1.0/openapi.yaml`, `microsoft.graph.message`, `.event`,
 * `.driveItem`, ...). Only the properties used here; every one optional,
 * since `$select` decides which come back.
 */

interface GraphEmailAddress {
  address?: string;
  name?: string;
}

export interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

interface GraphItemBody {
  contentType?: "text" | "html";
  content?: string;
}

export interface GraphAttachment {
  "@odata.type"?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
}

export interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: GraphItemBody;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  categories?: string[];
  attachments?: GraphAttachment[];
}

export interface GraphMailFolder {
  id: string;
  displayName?: string;
}

interface GraphDateTimeTimeZone {
  dateTime: string;
  timeZone: string;
}

export interface GraphResponseStatus {
  response?:
    | "none"
    | "organizer"
    | "tentativelyAccepted"
    | "accepted"
    | "declined"
    | "notResponded";
  time?: string;
}

interface GraphAttendee {
  emailAddress?: GraphEmailAddress;
  type?: "required" | "optional" | "resource";
  status?: GraphResponseStatus;
}

export interface GraphEvent {
  id: string;
  subject?: string;
  body?: GraphItemBody;
  start?: GraphDateTimeTimeZone;
  end?: GraphDateTimeTimeZone;
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  location?: { displayName?: string };
  organizer?: GraphRecipient;
  attendees?: GraphAttendee[];
  responseStatus?: GraphResponseStatus;
  onlineMeeting?: { joinUrl?: string } | null;
  webLink?: string;
}

export interface GraphCalendar {
  id: string;
  name?: string;
}

interface GraphScheduleItem {
  status?:
    "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";
  start?: GraphDateTimeTimeZone;
  end?: GraphDateTimeTimeZone;
}

export interface GraphScheduleInformation {
  scheduleId?: string;
  scheduleItems?: GraphScheduleItem[];
  error?: { message?: string; responseCode?: string };
}

export interface GraphDriveItem {
  id: string;
  name?: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  lastModifiedBy?: { user?: { displayName?: string; email?: string } };
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  package?: { type?: string };
  parentReference?: { driveId?: string; id?: string };
  remoteItem?: { id?: string; parentReference?: { driveId?: string } };
}

export interface GraphUploadSession {
  uploadUrl?: string;
  expirationDateTime?: string;
  nextExpectedRanges?: string[];
}
