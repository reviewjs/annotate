// Generated from annotate.d.ts. Do not edit directly.
export interface AnnotateConfig {
  /** Storage namespace shared by pages in one project. */
  project?: string;
  /** Fixed page key. By default Annotate follows location.pathname. */
  page?: string;
  accent?: string;
  theme?: 'auto' | 'light' | 'dark';
  position?: 'bottom-right' | 'bottom-left';
  blocks?: string;
  startOpen?: boolean;
  note?: string;
  /** Email address or issue URL template. {page}, {count}, {summary} are URL encoded. */
  shareEmail?: string;
  /** Watch History API navigation and popstate. */
  spa?: boolean;
  /** HTTP endpoint receiving the JSON export on an explicit Send feedback action. */
  postUrl?: string;
  /** Base URL of an annotate wire-protocol backend. Requires reviewId. */
  api?: string;
  /** Review to sync with when api is set. */
  reviewId?: string;
  /** Query parameter carrying the invite token. Default "an_invite". */
  inviteParam?: string;
  /** Poll interval in milliseconds for remote reads. Default 20000, minimum 500. */
  pollInterval?: number;
  /** Integrator-managed auth. Replaces the built-in invite-link exchange. */
  auth?: AnnotateAuth;
}

export interface AnnotateAuth {
  /** Returns a bearer token for the backend, or null when signed out. */
  getToken(): Promise<string | null> | string | null;
  /** Called when the backend refuses the token after one refresh. */
  onUnauthorized?(): void;
}

export interface ResolvedAnnotateConfig {
  project: string;
  page: string;
  accent: string;
  theme: 'auto' | 'light' | 'dark';
  position: 'bottom-right' | 'bottom-left';
  blocks: string;
  startOpen: boolean;
  note: string;
  share: string;
  spa: boolean;
  postUrl: string;
  api: string;
  reviewId: string;
  inviteParam: string;
  pollInterval: number;
}

export type AnnotateStatus = 'open' | 'in_progress' | 'resolved' | 'wont_fix';

export type AnnotateGeom =
  | { kind: 'rect' | 'circle'; selector: string; x: number; y: number; w: number; h: number; vw?: number; vh?: number }
  | { kind: 'pin'; selector?: string; x: number; y: number; vw?: number; vh?: number }
  | { kind: 'pen'; selector: string; points: Array<[number, number]>; vw?: number; vh?: number }
  | { kind: 'block'; selector: string };

export interface AnnotateAssignee {
  id: string | null;
  name: string;
}

export interface AnnotateReply {
  id: string;
  author: string;
  authorId: string | null;
  text: string;
  createdAt: string;
  editedAt: string | null;
}

/** Record schema v2 (docs/backlog/wire-protocol.md). */
export interface AnnotateComment {
  schema: 2;
  id: string;
  page: string;
  url: string;
  type: 'highlight' | 'shape' | 'pin' | 'pen' | 'note' | 'block';
  author: string;
  authorId: string | null;
  text: string;
  color: string;
  anchor: { exact: string; prefix: string; suffix: string } | null;
  geom: AnnotateGeom | null;
  visibility: 'shared' | 'private';
  status: AnnotateStatus;
  /** Derived: true when status is "resolved" or "wont_fix". */
  resolved: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
  assignee: AnnotateAssignee | null;
  assignedAt: string | null;
  replies: AnnotateReply[];
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
}

export interface AnnotateSyncState {
  state: 'local' | 'idle' | 'pending' | 'offline' | 'error';
  pending: number;
}

export interface FeedbackExport {
  annotate: string;
  schema: 2;
  kind: 'annotate-export';
  exportedAt: string;
  page: string;
  url: string;
  project: string;
  exportedViewport: { vw: number; vh: number; dpr: number };
  comments: AnnotateComment[];
}

export interface AnnotateAPI {
  readonly version: string;
  readonly config: ResolvedAnnotateConfig | null;
  init(config?: AnnotateConfig): AnnotateAPI;
  destroy(): void;
  open(): void;
  close(): void;
  toggle(): void;
  enable(): void;
  disable(): void;
  setTool(tool: 'cursor' | 'highlight' | 'rect' | 'circle' | 'pen' | 'pin'): void;
  refresh(): void;
  comments(): AnnotateComment[];
  focus(id: string): void;
  toast(message: string, options?: { kind?: 'info' | 'error' | 'success'; duration?: number }): void;
  export(): void;
  import(): void;
  /**
   * Local mode: sends the current page's export JSON to postUrl; rejects on failure.
   * With api: resolves once every queued change is acknowledged by the backend
   * (then also POSTs to postUrl when set).
   */
  submit(): Promise<FeedbackExport>;
  /** Moves a comment through its lifecycle. The creator and review authors may do this. */
  setStatus(id: string, status: AnnotateStatus): AnnotateComment | null;
  /** Assigns a comment to someone, or clears the assignee with null. Review authors only; the backend rejects a reviewer's change. */
  assign(id: string, assignee: AnnotateAssignee | null): AnnotateComment | null;
  /** Remote sync status; "local" when no backend is configured. */
  syncState(): AnnotateSyncState;
  /** Local mode: removes this page's comments. With api: removes only your own. */
  clear(): void;
}

declare const Annotate: AnnotateAPI;
export function init(config?: AnnotateConfig): AnnotateAPI;
export function destroy(): void;
export default Annotate;

export interface AnnotateEventMap {
  'annotate:sync': CustomEvent<AnnotateSyncState>;
  'annotate:auth': CustomEvent<{ reviewer: { id: string; name: string; role: 'reviewer' | 'author' } | null }>;
}

declare global {
  interface WindowEventMap extends AnnotateEventMap {}
  interface Window {
    Annotate?: AnnotateAPI;
    AnnotateConfig?: AnnotateConfig;
  }
}
