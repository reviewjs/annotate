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
}

export interface AnnotateComment {
  id: string;
  page: string;
  url?: string;
  type: 'highlight' | 'shape' | 'pin' | 'pen' | 'note' | 'block';
  author: string;
  text: string;
  color: string;
  anchor?: { exact: string; prefix: string; suffix: string } | null;
  geom?: Record<string, unknown> | null;
  resolved: boolean;
  replies: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackExport {
  annotate: string;
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
  /** Sends the current page's export JSON to postUrl; rejects on failure. */
  submit(): Promise<FeedbackExport>;
  clear(): void;
}

declare const Annotate: AnnotateAPI;
export function init(config?: AnnotateConfig): AnnotateAPI;
export function destroy(): void;
export default Annotate;

declare global {
  interface Window {
    Annotate?: AnnotateAPI;
    AnnotateConfig?: AnnotateConfig;
  }
}
