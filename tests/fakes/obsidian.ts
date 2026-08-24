/**
 * A working stand-in for the Obsidian API, so tests can drive the *real*
 * plugin class end to end.
 *
 * Why this exists: the unit tests under `core/` prove the policy is right, but
 * they never touch `main.ts`, `settings.ts` or `obsidian-adapter.ts` — which
 * is precisely where a plugin breaks the first time it's loaded (a mis-wired
 * argument, a settings tab that throws while rendering, an adapter that
 * creates a file in the wrong place). This fake closes that gap without
 * needing Obsidian itself.
 *
 * It is deliberately faithful on the behaviours the plugin depends on:
 *   - `getAbstractFileByPath` returns `null` for anything absent, and a
 *     `TFile` (never a string) for a file — the plugin branches on
 *     `instanceof TFile`.
 *   - `create` throws if the parent folder doesn't exist, like the real Vault;
 *     that's what makes the adapter's `ensureFolder` call load-bearing.
 *   - `renameFile` moves the entry, so "keep = move out of Inbox/" is
 *     genuinely exercised.
 * It is *not* faithful about rendering — settings/modal DOM is real jsdom, so
 * a throw during `display()` is caught, but pixels are not checked.
 *
 * vitest aliases the `obsidian` module to this file (see vitest.config.ts).
 */

// --- DOM helpers Obsidian adds to HTMLElement --------------------------------

interface ElOptions {
  text?: string;
  cls?: string;
  type?: string;
  placeholder?: string;
  attr?: Record<string, string>;
}

function applyOptions(el: HTMLElement, options?: ElOptions): void {
  if (!options) return;
  if (options.text !== undefined) el.textContent = options.text;
  if (options.cls) el.className = options.cls;
  if (options.type) el.setAttribute("type", options.type);
  if (options.placeholder) el.setAttribute("placeholder", options.placeholder);
  for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
}

/** Install Obsidian's HTMLElement extensions onto jsdom's prototype. */
export function installDomExtensions(): void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  if (proto.__literatureInboxPatched) return;

  proto.createEl = function (tag: string, options?: ElOptions) {
    const el = document.createElement(tag);
    applyOptions(el, options);
    (this as unknown as HTMLElement).appendChild(el);
    return el;
  };
  proto.createDiv = function (options?: ElOptions) {
    return (this as unknown as { createEl: (t: string, o?: ElOptions) => HTMLElement }).createEl(
      "div",
      options,
    );
  };
  proto.createSpan = function (options?: ElOptions) {
    return (this as unknown as { createEl: (t: string, o?: ElOptions) => HTMLElement }).createEl(
      "span",
      options,
    );
  };
  proto.empty = function () {
    const el = this as unknown as HTMLElement;
    while (el.firstChild) el.removeChild(el.firstChild);
  };
  proto.setText = function (text: string) {
    (this as unknown as HTMLElement).textContent = text;
  };
  proto.addClass = function (cls: string) {
    (this as unknown as HTMLElement).classList.add(cls);
  };
  proto.removeClass = function (cls: string) {
    (this as unknown as HTMLElement).classList.remove(cls);
  };
  proto.__literatureInboxPatched = true;
}

installDomExtensions();

// --- file tree ----------------------------------------------------------------

export class TAbstractFile {
  constructor(public path: string) {}
  get name(): string {
    return this.path.split("/").pop() ?? this.path;
  }
}

export class TFile extends TAbstractFile {
  get basename(): string {
    return this.name.replace(/\.md$/, "");
  }
  get extension(): string {
    return this.name.includes(".") ? (this.name.split(".").pop() as string) : "";
  }
}

export class TFolder extends TAbstractFile {}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export class Vault {
  /** path -> contents */
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  /** Every mutating call, so tests can assert on write amplification. */
  readonly log: string[] = [];

  getAbstractFileByPath(path: string): TAbstractFile | null {
    const normalized = normalizePath(path);
    if (this.files.has(normalized)) return new TFile(normalized);
    if (this.folders.has(normalized)) return new TFolder(normalized);
    return null;
  }

  async read(file: TFile): Promise<string> {
    const content = this.files.get(normalizePath(file.path));
    if (content === undefined) throw new Error(`ENOENT: ${file.path}`);
    return content;
  }

  async create(path: string, content: string): Promise<TFile> {
    const normalized = normalizePath(path);
    if (this.files.has(normalized)) throw new Error(`File already exists: ${normalized}`);
    const parent = normalized.split("/").slice(0, -1).join("/");
    // The real Vault refuses to create a file inside a folder that doesn't
    // exist — this is what makes the adapter's ensureFolder call meaningful.
    if (parent && !this.folders.has(parent)) {
      throw new Error(`Folder does not exist: ${parent}`);
    }
    this.files.set(normalized, content);
    this.log.push(`create ${normalized}`);
    return new TFile(normalized);
  }

  async modify(file: TFile, content: string): Promise<void> {
    const normalized = normalizePath(file.path);
    if (!this.files.has(normalized)) throw new Error(`ENOENT: ${normalized}`);
    this.files.set(normalized, content);
    this.log.push(`modify ${normalized}`);
  }

  async createFolder(path: string): Promise<TFolder> {
    const normalized = normalizePath(path);
    if (this.folders.has(normalized)) throw new Error(`Folder already exists: ${normalized}`);
    // Obsidian creates intermediate folders.
    const parts = normalized.split("/");
    for (let i = 1; i <= parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
    this.log.push(`createFolder ${normalized}`);
    return new TFolder(normalized);
  }

  async delete(file: TAbstractFile): Promise<void> {
    this.files.delete(normalizePath(file.path));
  }

  getFiles(): TFile[] {
    return [...this.files.keys()].map((path) => new TFile(path));
  }
}

export class FileManager {
  readonly trashed: string[] = [];

  constructor(private readonly vault: Vault) {}

  async trashFile(file: TFile): Promise<void> {
    const normalized = normalizePath(file.path);
    this.vault.files.delete(normalized);
    this.trashed.push(normalized);
  }

  async renameFile(file: TFile, newPath: string): Promise<void> {
    const from = normalizePath(file.path);
    const to = normalizePath(newPath);
    const content = this.vault.files.get(from);
    if (content === undefined) throw new Error(`ENOENT: ${from}`);
    this.vault.files.delete(from);
    this.vault.files.set(to, content);
    this.vault.log.push(`rename ${from} -> ${to}`);
  }
}

export class MenuItem {
  title = "";
  private clickHandler?: () => unknown;

  setTitle(title: string): this {
    this.title = title;
    return this;
  }
  setIcon(_icon: string | null): this {
    return this;
  }
  onClick(fn: () => unknown): this {
    this.clickHandler = fn;
    return this;
  }
  /** Test helper: simulate the user actually clicking this menu item. */
  click(): void {
    void this.clickHandler?.();
  }
}

export class Menu {
  readonly items: MenuItem[] = [];
  addItem(cb: (item: MenuItem) => unknown): this {
    const item = new MenuItem();
    cb(item);
    this.items.push(item);
    return this;
  }
}

type WorkspaceListener = (...args: unknown[]) => unknown;

export class Workspace {
  activeFile: TFile | null = null;
  readonly opened: string[] = [];
  private readonly listeners = new Map<string, WorkspaceListener[]>();

  getActiveFile(): TFile | null {
    return this.activeFile;
  }

  getLeaf(_newLeaf?: boolean) {
    return {
      openFile: async (file: TFile) => {
        this.opened.push(file.path);
      },
    };
  }

  on(name: string, callback: WorkspaceListener): { name: string } {
    const list = this.listeners.get(name) ?? [];
    list.push(callback);
    this.listeners.set(name, list);
    return { name };
  }

  /** Test helper: build the context menu Obsidian would show for a
   * multi-file selection, so a test can find and click an added item. */
  triggerFilesMenu(files: TFile[]): Menu {
    const menu = new Menu();
    for (const cb of this.listeners.get("files-menu") ?? []) cb(menu, files, "test");
    return menu;
  }

  /** Same, for a single-file right-click. */
  triggerFileMenu(file: TFile): Menu {
    const menu = new Menu();
    for (const cb of this.listeners.get("file-menu") ?? []) cb(menu, file, "test");
    return menu;
  }
}

export class MetadataCache {
  /** path -> frontmatter, populated by tests. */
  readonly frontmatter = new Map<string, Record<string, unknown>>();

  getFileCache(file: TFile): { frontmatter?: Record<string, unknown> } | null {
    const fm = this.frontmatter.get(normalizePath(file.path));
    return fm ? { frontmatter: fm } : null;
  }
}

export class App {
  readonly vault = new Vault();
  readonly workspace = new Workspace();
  readonly metadataCache = new MetadataCache();
  readonly fileManager = new FileManager(this.vault);
}

// --- plugin scaffolding --------------------------------------------------------

export interface Command {
  id: string;
  name: string;
  callback?: () => void;
  checkCallback?: (checking: boolean) => boolean;
}

export class Plugin {
  readonly commands: Command[] = [];
  settingTab: PluginSettingTab | null = null;
  private stored: unknown = null;

  constructor(readonly app: App, readonly manifest: Record<string, unknown> = {}) {}

  addCommand(command: Command): Command {
    this.commands.push(command);
    return command;
  }

  addSettingTab(tab: PluginSettingTab): void {
    this.settingTab = tab;
  }

  readonly ribbonIcons: { icon: string; title: string; callback: () => void }[] = [];

  addRibbonIcon(icon: string, title: string, callback: () => void): HTMLElement {
    this.ribbonIcons.push({ icon, title, callback });
    return document.createElement("div");
  }

  addStatusBarItem(): HTMLElement {
    return document.createElement("div");
  }

  async loadData(): Promise<unknown> {
    // Round-trip through JSON like the real thing, so a value that can't be
    // serialized fails here rather than silently in production.
    return this.stored === null ? null : JSON.parse(JSON.stringify(this.stored));
  }

  async saveData(data: unknown): Promise<void> {
    this.stored = JSON.parse(JSON.stringify(data));
  }

  registerEvent(): void {}
  registerInterval(): number {
    throw new Error("registerInterval must not be used: this plugin never runs on a timer");
  }
}

export class PluginSettingTab {
  containerEl: HTMLElement = document.createElement("div");
  constructor(readonly app: App, readonly plugin: Plugin) {}
  display(): void {}
  hide(): void {}
}

export class Modal {
  containerEl: HTMLElement = document.createElement("div");
  titleEl: HTMLElement = document.createElement("div");
  contentEl: HTMLElement = document.createElement("div");
  isOpen = false;

  constructor(readonly app: App) {}

  open(): void {
    this.isOpen = true;
    this.onOpen();
  }
  close(): void {
    this.isOpen = false;
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

/** Every notice raised, so tests can assert on what the user was told. */
export const notices: string[] = [];

export class Notice {
  constructor(message: string, _duration?: number) {
    notices.push(message);
  }
}

export function clearNotices(): void {
  notices.length = 0;
}

// --- settings components --------------------------------------------------------

class BaseComponent {
  onChangeCallback?: (value: string | boolean) => unknown;
  disabled = false;
  setDisabled(value: boolean): this {
    this.disabled = value;
    return this;
  }
}

export class TextComponent extends BaseComponent {
  value = "";
  placeholder = "";
  setPlaceholder(placeholder: string): this {
    this.placeholder = placeholder;
    return this;
  }
  setValue(value: string): this {
    this.value = value;
    return this;
  }
  getValue(): string {
    return this.value;
  }
  onChange(cb: (value: string) => unknown): this {
    this.onChangeCallback = cb as (value: string | boolean) => unknown;
    return this;
  }
  /** Test helper: simulate the user typing. */
  async simulateInput(value: string): Promise<void> {
    this.value = value;
    await this.onChangeCallback?.(value);
  }
}

export class ToggleComponent extends BaseComponent {
  value = false;
  tooltip = "";
  setValue(value: boolean): this {
    this.value = value;
    return this;
  }
  setTooltip(tooltip: string): this {
    this.tooltip = tooltip;
    return this;
  }
  getValue(): boolean {
    return this.value;
  }
  onChange(cb: (value: boolean) => unknown): this {
    this.onChangeCallback = cb as (value: string | boolean) => unknown;
    return this;
  }
  async simulateToggle(value: boolean): Promise<void> {
    this.value = value;
    await this.onChangeCallback?.(value);
  }
}

export class DropdownComponent extends BaseComponent {
  value = "";
  /** Option value -> label, in the order they were added. */
  readonly options = new Map<string, string>();
  addOption(value: string, label: string): this {
    this.options.set(value, label);
    return this;
  }
  setValue(value: string): this {
    this.value = value;
    return this;
  }
  getValue(): string {
    return this.value;
  }
  onChange(cb: (value: string) => unknown): this {
    this.onChangeCallback = cb as (value: string | boolean) => unknown;
    return this;
  }
  /** Test helper: simulate the user picking an option. */
  async simulateSelect(value: string): Promise<void> {
    this.value = value;
    await this.onChangeCallback?.(value);
  }
}

export class ButtonComponent extends BaseComponent {
  text = "";
  tooltip = "";
  icon = "";
  isCta = false;
  clickCallback?: () => unknown;
  setButtonText(text: string): this {
    this.text = text;
    return this;
  }
  setTooltip(tooltip: string): this {
    this.tooltip = tooltip;
    return this;
  }
  setIcon(icon: string): this {
    this.icon = icon;
    return this;
  }
  setCta(): this {
    this.isCta = true;
    return this;
  }
  setWarning(): this {
    return this;
  }
  onClick(cb: () => unknown): this {
    this.clickCallback = cb;
    return this;
  }
  async simulateClick(): Promise<void> {
    await this.clickCallback?.();
  }
}

export class Setting {
  name = "";
  desc = "";
  isHeading = false;
  readonly texts: TextComponent[] = [];
  readonly toggles: ToggleComponent[] = [];
  readonly buttons: ButtonComponent[] = [];
  readonly dropdowns: DropdownComponent[] = [];
  readonly settingEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.settingEl = document.createElement("div");
    containerEl.appendChild(this.settingEl);
    allSettings.push(this);
  }

  setName(name: string): this {
    this.name = name;
    return this;
  }
  setClass(cls: string): this {
    this.settingEl.classList.add(cls);
    return this;
  }
  setDesc(desc: string): this {
    this.desc = desc;
    return this;
  }
  setHeading(): this {
    this.isHeading = true;
    return this;
  }
  addText(cb: (component: TextComponent) => unknown): this {
    const component = new TextComponent();
    this.texts.push(component);
    cb(component);
    return this;
  }
  addTextArea(cb: (component: TextComponent) => unknown): this {
    return this.addText(cb);
  }
  addToggle(cb: (component: ToggleComponent) => unknown): this {
    const component = new ToggleComponent();
    this.toggles.push(component);
    cb(component);
    return this;
  }
  addButton(cb: (component: ButtonComponent) => unknown): this {
    const component = new ButtonComponent();
    this.buttons.push(component);
    cb(component);
    return this;
  }
  addDropdown(cb: (component: DropdownComponent) => unknown): this {
    const component = new DropdownComponent();
    this.dropdowns.push(component);
    cb(component);
    return this;
  }
}

/** Every Setting constructed, so a test can find one by name. */
export const allSettings: Setting[] = [];

export function clearSettings(): void {
  allSettings.length = 0;
}

// --- platform / network -----------------------------------------------------------

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
};

export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  text: string;
  json: unknown;
  headers: Record<string, string>;
  retryAfter?: string;
}

type ResponderResult = { status: number; text: string; retryAfter?: string };
/** May be async, so a live harness can point this at the real network while
 * hermetic tests keep returning canned bytes synchronously. */
type Responder = (url: string) => ResponderResult | Promise<ResponderResult>;

let responder: Responder = () => {
  throw new Error(
    "requestUrl was called but no responder is installed — tests must not hit the network",
  );
};

/** Install the canned network behaviour for a test. */
export function setRequestResponder(fn: Responder): void {
  responder = fn;
}

export const requestedUrls: string[] = [];

export function clearRequests(): void {
  requestedUrls.length = 0;
}

export async function requestUrl(param: RequestUrlParam | string): Promise<RequestUrlResponse> {
  const url = typeof param === "string" ? param : param.url;
  requestedUrls.push(url);
  const { status, text, retryAfter } = await responder(url);
  return {
    status,
    text,
    retryAfter,
    get json() {
      return JSON.parse(text);
    },
    headers: {},
  };
}

/** Reset every module-level collector between tests. */
export function resetFakeObsidian(): void {
  clearNotices();
  clearSettings();
  clearRequests();
  Platform.isDesktop = true;
  responder = () => {
    throw new Error("requestUrl was called but no responder is installed");
  };
}
