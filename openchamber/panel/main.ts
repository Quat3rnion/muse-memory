// Memory panel: browse and curate musemem claims, legacy Mem0 entries, dreams and the pinned block.
import { connectHost, HostRequestError } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountSearchField,
  mountSelect,
  mountSpinner,
  mountSwitch,
  mountTabs,
  mountTextField,
  type ButtonProps,
  type CheckboxHandle,
  type SearchFieldHandle,
  type SelectHandle,
  type SelectOption,
  type TabsHandle,
  type Tone,
} from '@openchamber/sdk/ui';
import {
  KINDS,
  type AdoptResult,
  type Claim,
  type ClaimDetail,
  type ClaimList,
  type DreamFile,
  type DreamsIndex,
  type Kind,
  type LegacyItem,
  type LegacyList,
  type PinnedText,
  type RepairThread,
  type Sort,
  type Stats,
  type StatusFilter,
  type TextResult,
} from '../shared/types.ts';
import { CSS } from './css.ts';
import { renderInlineText, renderMarkdown } from './markdown.ts';
import {
  dateTime,
  fixed2,
  humanKey,
  legacyLabels,
  legacyMatches,
  oneLine,
  pageLabel,
  plural,
  relativeTime,
  runSummary,
  runTime,
  shortDate,
} from './util.ts';

const host = connectHost();
const PAGE = 50;
const PINNED_MAX = 4000;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const ICONS = {
  pin: 'M18 3v2h-1v6l2 3v2h-6v7h-2v-7H5v-2l2-3V5H6V3h12z',
  refresh:
    'M5.463 4.433A9.961 9.961 0 0 1 12 2c5.523 0 10 4.477 10 10 0 2.136-.67 4.116-1.81 5.74L17 12h3A8 8 0 0 0 6.46 6.228l-.997-1.795zm13.074 15.134A9.961 9.961 0 0 1 12 22C6.477 22 2 17.523 2 12c0-2.136.67-4.116 1.81-5.74L7 12H4a8 8 0 0 0 13.54 5.772l.997 1.795z',
  back: 'M7.828 11H20v2H7.828l5.364 5.364-1.414 1.414L4 12l7.778-7.778 1.414 1.414z',
} as const;

const icon = (name: keyof typeof ICONS): SVGSVGElement => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
};

const iconButton = (name: keyof typeof ICONS, label: string, onClick: () => void): HTMLButtonElement => {
  const b = el('button', 'icon-btn');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(name));
  b.addEventListener('click', onClick);
  return b;
};

const linkButton = (label: string, onClick: () => void, className = 'link'): HTMLButtonElement => {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

/** A node whose children are rebuilt often. It disposes the SDK controls of the last build. */
class Region {
  private handles: Array<{ dispose: () => void }> = [];
  constructor(readonly node: HTMLElement) {}
  reset(): HTMLElement {
    for (const h of this.handles) h.dispose();
    this.handles = [];
    this.node.replaceChildren();
    return this.node;
  }
  keep<T extends { dispose: () => void }>(handle: T): T {
    this.handles.push(handle);
    return handle;
  }
  button(parent: Element, props: ButtonProps): ReturnType<typeof mountButton> {
    return this.keep(mountButton(parent, props));
  }
  badge(parent: Element, label: string, tone?: Tone): void {
    this.keep(mountBadge(parent, { label, ...(tone ? { tone } : {}) }));
  }
  spinner(parent: Element, label: string): void {
    const box = el('div', 'state');
    parent.append(box);
    this.keep(mountSpinner(box, { label }));
  }
  empty(parent: Element, title: string, body?: string): void {
    const box = el('div', 'state');
    parent.append(box);
    this.keep(mountEmpty(box, { title, ...(body ? { body } : {}) }));
  }
  error(parent: Element, message: string, retry: () => void): void {
    const box = el('div', 'state');
    parent.append(box);
    this.keep(mountBanner(box, { tone: 'error', title: 'Could not load', body: message, action: { label: 'Try again', onClick: retry } }));
  }
}

// ---------------------------------------------------------------------------
// Service API
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly busy: boolean,
  ) {
    super(message);
  }
}

const api = async <T>(method: 'GET' | 'POST', path: string, options: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> => {
  const response = await host.serviceRequest({
    method,
    path,
    ...(options.query ? { query: options.query } : {}),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  let data: unknown = null;
  try {
    data = JSON.parse(response.body);
  } catch {
    data = null;
  }
  if (response.status >= 400) {
    const body = (data ?? {}) as { error?: unknown; busy?: unknown };
    const message = typeof body.error === 'string' ? body.error : `The service answered ${response.status}`;
    throw new ApiError(message, response.status, body.busy === true || response.status === 409 || response.status === 429);
  }
  return data as T;
};

const errorText = (error: unknown): string => {
  if (error instanceof HostRequestError) {
    if (error.code === 'NO_SERVICE') return 'The Memory service is not running. Open Settings, Extensions, allow the Memory service, then reload this panel.';
    if (error.code === 'SERVICE_FAILED') return 'The Memory service stopped. It starts again on the next request.';
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof ApiError && error.busy) return 'Memory is busy with another musemem run. Try again in a moment.';
  return error instanceof Error ? error.message : String(error);
};

const toast = (kind: 'info' | 'success' | 'error', message: string): void => {
  void host.toast({ kind, message: message.slice(0, 400) }).catch(() => undefined);
};

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type Tab = 'claims' | 'legacy' | 'dreams' | 'pinned';
type DreamView = 'synthesis' | 'state' | string;

interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  seq: number;
}
const loadable = <T>(): Loadable<T> => ({ data: null, loading: false, error: null, seq: 0 });

/** Runs a load, ignores answers that a newer load replaced, then calls render. */
const load = async <T>(slot: Loadable<T>, fetcher: () => Promise<T>, render: () => void, keepData = true): Promise<void> => {
  const seq = ++slot.seq;
  slot.loading = true;
  slot.error = null;
  if (!keepData) slot.data = null;
  render();
  try {
    const data = await fetcher();
    if (seq !== slot.seq) return;
    slot.data = data;
  } catch (error) {
    if (seq !== slot.seq) return;
    slot.error = errorText(error);
  }
  slot.loading = false;
  render();
};

const model = {
  tab: 'claims' as Tab,
  layout: 'wide' as 'wide' | 'narrow',
  stats: loadable<Stats>(),
  filters: { q: '', status: 'active' as StatusFilter, kind: '' as Kind | '', entity: '', pinned: false, sort: 'salience' as Sort, offset: 0 },
  list: loadable<ClaimList>(),
  selected: null as string | null,
  pane: 'list' as 'list' | 'detail',
  detail: loadable<ClaimDetail>(),
  editing: false,
  legacy: loadable<LegacyList>(),
  legacyQ: '',
  dreams: loadable<DreamsIndex>(),
  dreamView: 'synthesis' as DreamView,
  dreamDoc: loadable<DreamFile>(),
  pinnedText: loadable<PinnedText>(),
  pinnedDraft: null as string | null,
  pinnedSaving: false,
  pinnedClaims: loadable<ClaimList>(),
  stale: { legacy: true, dreams: true, pinned: true },
};

const KIND_LABEL: Record<Kind, string> = {
  fact: 'Fact',
  preference: 'Preference',
  commitment: 'Commitment',
  experience: 'Experience',
  opinion: 'Opinion',
};
const STATUS_LABEL: Record<string, string> = { active: 'Active', superseded: 'Superseded', retracted: 'Retracted', all: 'All' };
const STATUS_TONE: Record<string, Tone | undefined> = { active: 'success', superseded: 'warning', retracted: 'error' };
const VIEW_LABEL: Record<Tab, string> = { claims: 'Claims', legacy: 'Legacy Mem0 entries', dreams: 'Dreams', pinned: 'Pinned' };
const SORT_LABEL: Record<Sort, string> = { salience: 'Salience', recent: 'Newest', confidence: 'Confidence' };

// ---------------------------------------------------------------------------
// Shell: header, tabs, views
// ---------------------------------------------------------------------------

const ui = {
  app: el('div', 'app'),
  head: el('header', 'head'),
  counts: new Region(el('ul', 'counts')),
  runs: el('div', 'runs'),
  runsText: el('span'),
  refresh: null as HTMLButtonElement | null,
  tabsBox: el('nav', 'tabs'),
  tabs: null as TabsHandle | null,
  banners: new Region(el('div', 'banners')),
  views: {
    claims: el('section', 'view'),
    legacy: el('section', 'view'),
    dreams: el('section', 'view'),
    pinned: el('section', 'view'),
  } as Record<Tab, HTMLElement>,
};

const tabItems = () => {
  const s = model.stats.data;
  const legacyTotal = model.legacy.data?.total;
  return [
    { id: 'claims', label: 'Claims', ...(s ? { count: s.status.active ?? 0 } : {}) },
    { id: 'legacy', label: 'Legacy (Mem0)', ...(legacyTotal !== undefined ? { count: legacyTotal } : {}) },
    { id: 'dreams', label: 'Dreams' },
    { id: 'pinned', label: 'Pinned', ...(s ? { count: s.pinned } : {}) },
  ];
};

const renderHeader = (): void => {
  const s = model.stats.data;
  const counts = ui.counts.reset();
  if (s) {
    const item = (n: number, label: string, warn = false): void => {
      const li = el('li', warn ? 'warn' : '');
      li.append(el('b', '', n.toLocaleString()), document.createTextNode(label));
      counts.append(li);
    };
    item(s.status.active ?? 0, 'active');
    item(s.status.superseded ?? 0, 'superseded');
    if (s.status.retracted) item(s.status.retracted, 'retracted');
    item(s.pinned, 'pinned');
    if (model.legacy.data) item(model.legacy.data.total, 'in Mem0 only');
  } else if (model.stats.error) {
    counts.append(el('li', '', 'Counts are not available.'));
  }
  const parts: string[] = [];
  const titles: string[] = [];
  const consolidate = runTime(s?.runs.consolidate);
  const dream = runTime(s?.runs.dream);
  if (consolidate) {
    parts.push(`Consolidated ${relativeTime(consolidate)}`);
    titles.push(`Consolidate: ${dateTime(consolidate)}. ${runSummary(s?.runs.consolidate)}`);
  }
  if (dream) {
    parts.push(`Dreamed ${relativeTime(dream)}`);
    titles.push(`Dream: ${dateTime(dream)}. ${runSummary(s?.runs.dream)}`);
  }
  ui.runsText.textContent = s ? (parts.length > 0 ? parts.join(' · ') : 'No runs yet') : '';
  ui.runsText.title = titles.join('\n');
  ui.tabs?.update({ items: tabItems() });

  const banners = ui.banners.reset();
  if (s?.pending_forget) {
    const box = el('div');
    banners.append(box);
    ui.banners.keep(
      mountBanner(box, { tone: 'warning', title: 'A forget is not finished', body: 'musemem finishes it on its next run. Some views can still show the old text.' }),
    );
  }
};

const loadStats = (): Promise<void> => load(model.stats, () => api<Stats>('GET', '/stats'), () => {
  renderHeader();
  syncFilterOptions();
});

const setTab = (tab: Tab): void => {
  model.tab = tab;
  ui.tabs?.update({ activeId: tab });
  for (const [id, node] of Object.entries(ui.views)) node.hidden = id !== tab;
  if (tab === 'legacy' && model.stale.legacy) void loadLegacy();
  if (tab === 'dreams' && model.stale.dreams) void loadDreams();
  if (tab === 'pinned' && model.stale.pinned) void loadPinned();
  void host.storage.set('tab', tab).catch(() => undefined);
};

const refreshAll = async (): Promise<void> => {
  if (ui.refresh) {
    ui.refresh.disabled = true;
    ui.refresh.classList.add('spin');
  }
  model.stale = { legacy: true, dreams: true, pinned: true };
  const jobs: Array<Promise<void>> = [loadStats()];
  if (model.tab === 'claims') jobs.push(loadList(), ...(model.selected ? [loadDetail()] : []));
  if (model.tab === 'legacy') jobs.push(loadLegacy());
  if (model.tab === 'dreams') jobs.push(loadDreams());
  if (model.tab === 'pinned') jobs.push(loadPinned());
  await Promise.allSettled(jobs);
  if (ui.refresh) {
    ui.refresh.disabled = false;
    ui.refresh.classList.remove('spin');
  }
};

/** After a change: toast, then reload every view that shows the changed data. */
const afterChange = async (message: string, scope: { legacy?: boolean } = {}): Promise<void> => {
  toast('success', message);
  model.stale.pinned = true;
  model.stale.dreams = true;
  if (scope.legacy) model.stale.legacy = true;
  const jobs: Array<Promise<void>> = [loadStats(), loadList()];
  if (model.selected) jobs.push(loadDetail());
  if (model.tab === 'pinned') jobs.push(loadPinned());
  if (model.tab === 'legacy' && scope.legacy) jobs.push(loadLegacy());
  await Promise.allSettled(jobs);
};

// ---------------------------------------------------------------------------
// Claims: filters and list
// ---------------------------------------------------------------------------

const claims = {
  split: el('div', 'split'),
  listPane: el('div', 'pane list-pane'),
  filters: el('div', 'filters'),
  resultLine: el('div', 'result-line'),
  rows: new Region(el('div', 'scroll')),
  pager: new Region(el('div', 'pager')),
  detailPane: el('div', 'pane detail-pane'),
  detail: new Region(el('div', 'scroll')),
  search: null as SearchFieldHandle | null,
  status: null as SelectHandle | null,
  kind: null as SelectHandle | null,
  entity: null as SelectHandle | null,
  sort: null as SelectHandle | null,
  pinned: null as CheckboxHandle | null,
  toggle: el('button', 'filters-toggle'),
  clear: Object.assign(el('button', 'text-btn', 'Clear filters'), { type: 'button' as const }),
};

const statusOptions = (): SelectOption[] => {
  const counts = model.stats.data?.status ?? {};
  return (['active', 'superseded', 'retracted', 'all'] as const).map((id) => {
    const n = id === 'all' ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[id];
    return { id, label: STATUS_LABEL[id] ?? id, ...(n !== undefined ? { hint: String(n) } : {}) };
  });
};

const kindOptions = (): SelectOption[] => {
  const counts = model.stats.data?.kind ?? {};
  return [
    { id: 'any', label: 'Any kind' },
    ...KINDS.map((k) => ({ id: k, label: KIND_LABEL[k], ...(counts[k] !== undefined ? { hint: String(counts[k]) } : {}) })),
  ];
};

const entityOptions = (): SelectOption[] => {
  const entities = model.stats.data?.entities ?? {};
  const options: SelectOption[] = [{ id: 'any', label: 'Any entity' }];
  for (const [name, count] of Object.entries(entities)) options.push({ id: `e:${name}`, label: name, hint: String(count) });
  const current = model.filters.entity;
  if (current && !(current in entities)) options.push({ id: `e:${current}`, label: current });
  return options;
};

const syncFilterOptions = (): void => {
  claims.status?.update({ options: statusOptions(), value: model.filters.status });
  claims.kind?.update({ options: kindOptions(), value: model.filters.kind || 'any' });
  claims.entity?.update({ options: entityOptions(), value: model.filters.entity ? `e:${model.filters.entity}` : 'any' });
};

const setFilter = (change: Partial<typeof model.filters>): void => {
  Object.assign(model.filters, change, { offset: 'offset' in change ? change.offset : 0 });
  syncFilterOptions();
  claims.pinned?.update({ checked: model.filters.pinned });
  claims.sort?.update({ value: model.filters.sort });
  syncFilterSummary();
  void loadList();
};

let searchTimer: ReturnType<typeof setTimeout> | undefined;

const buildFilters = (): void => {
  const f = claims.filters;
  const searchRow = el('div', 'search-row');
  const searchBox = el('div');
  searchRow.append(searchBox, claims.toggle);
  f.append(searchRow);
  claims.toggle.type = 'button';
  claims.toggle.setAttribute('aria-expanded', 'false');
  claims.toggle.setAttribute('aria-controls', 'claim-filters');
  claims.toggle.addEventListener('click', () => {
    const open = f.dataset.open !== 'true';
    f.dataset.open = String(open);
    claims.toggle.setAttribute('aria-expanded', String(open));
  });
  claims.search = mountSearchField(searchBox, {
    value: model.filters.q,
    placeholder: 'Search claims',
    label: 'Search claims',
    onChange: (value) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => setFilter({ q: value }), 250);
    },
  });
  const row = el('div', 'filter-row');
  row.id = 'claim-filters';
  f.append(row);
  const slot = (): HTMLElement => {
    const box = el('div');
    row.append(box);
    return box;
  };
  claims.status = mountSelect(slot(), {
    label: 'Status',
    value: model.filters.status,
    options: statusOptions(),
    onChange: (id) => setFilter({ status: id as StatusFilter }),
  });
  claims.kind = mountSelect(slot(), {
    label: 'Kind',
    value: 'any',
    options: kindOptions(),
    onChange: (id) => setFilter({ kind: id === 'any' ? '' : (id as Kind) }),
  });
  claims.entity = mountSelect(slot(), {
    label: 'Entity',
    value: 'any',
    options: entityOptions(),
    searchable: true,
    searchPlaceholder: 'Find an entity',
    onChange: (id) => setFilter({ entity: id === 'any' ? '' : id.slice(2) }),
  });
  claims.sort = mountSelect(slot(), {
    label: 'Sort by',
    value: model.filters.sort,
    options: (Object.keys(SORT_LABEL) as Sort[]).map((id) => ({ id, label: SORT_LABEL[id] })),
    onChange: (id) => setFilter({ sort: id as Sort }),
  });
  const foot = el('div', 'filter-foot');
  f.append(foot);
  const sw = el('div');
  foot.append(sw);
  claims.pinned = mountSwitch(sw, { label: 'Pinned only', checked: false, onChange: (checked) => setFilter({ pinned: checked }) });
  claims.clear.addEventListener('click', () => {
    claims.search?.update({ value: '' });
    clearTimeout(searchTimer);
    setFilter({ q: '', status: 'active', kind: '', entity: '', pinned: false, sort: 'salience' });
  });
  foot.append(claims.clear);
  syncFilterSummary();
};

/** How many filters differ from the defaults. Search text is not a filter here. */
const activeFilters = (): number => {
  const f = model.filters;
  return [f.status !== 'active', f.kind !== '', f.entity !== '', f.pinned, f.sort !== 'salience'].filter(Boolean).length;
};

const syncFilterSummary = (): void => {
  const n = activeFilters();
  claims.toggle.replaceChildren(document.createTextNode('Filters'));
  if (n > 0) claims.toggle.append(el('b', '', String(n)));
  claims.clear.hidden = n === 0 && model.filters.q === '';
};

const loadList = (): Promise<void> =>
  load(
    model.list,
    () => {
      const f = model.filters;
      const query: Record<string, string> = { status: f.status, sort: f.sort, limit: String(PAGE), offset: String(f.offset) };
      if (f.q.trim()) query.q = f.q.trim();
      if (f.kind) query.kind = f.kind;
      if (f.entity) query.entity = f.entity;
      if (f.pinned) query.pinned = 'true';
      return api<ClaimList>('GET', '/claims', { query });
    },
    renderList,
  );

const meter = (value: number, label: string): HTMLElement => {
  const m = el('span', 'meter');
  const bar = el('i');
  bar.style.setProperty('--v', `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`);
  m.title = `${label} ${fixed2(value)}`;
  m.append(bar, el('span', '', fixed2(value)));
  return m;
};

const renderList = (): void => {
  const slot = model.list;
  const box = claims.rows.reset();
  const line = claims.resultLine;
  line.replaceChildren();
  const pager = claims.pager.reset();
  const data = slot.data;
  const count = el('span', 'grow', data ? plural(data.total, 'claim') : slot.loading ? 'Loading' : '');
  count.setAttribute('aria-live', 'polite');
  line.append(count);
  if (slot.loading && data) line.append(el('span', '', 'Updating…'));

  if (slot.error) {
    claims.rows.error(box, slot.error, () => void loadList());
    pager.hidden = true;
    return;
  }
  if (!data) {
    claims.rows.spinner(box, 'Loading claims');
    pager.hidden = true;
    return;
  }
  if (data.items.length === 0) {
    const f = model.filters;
    const filtered = f.q || f.kind || f.entity || f.pinned || f.status !== 'active';
    claims.rows.empty(box, 'No claims', filtered ? 'Nothing matches these filters.' : 'musemem has not saved any claims yet.');
    pager.hidden = true;
    return;
  }
  const list = el('ul', 'rows');
  list.setAttribute('aria-label', 'Claims');
  for (const claim of data.items) {
    const li = el('li');
    const row = el('button', 'row');
    row.type = 'button';
    row.dataset.id = claim.id;
    row.dataset.status = claim.status;
    if (claim.id === model.selected) row.setAttribute('aria-current', 'true');
    row.append(el('span', 'row-text', claim.text));
    const meta = el('span', 'row-meta');
    if (claim.pinned) {
      const pin = el('span', 'pin');
      pin.title = 'Pinned';
      pin.append(icon('pin'), el('span', 'sr-only', 'Pinned'));
      meta.append(pin);
    }
    claims.rows.badge(meta, KIND_LABEL[claim.kind] ?? claim.kind);
    meta.append(meter(claim.salience, 'Salience'));
    if (claim.status !== 'active') claims.rows.badge(meta, STATUS_LABEL[claim.status] ?? claim.status, STATUS_TONE[claim.status]);
    row.append(meta);
    row.addEventListener('click', () => selectClaim(claim.id));
    li.append(row);
    list.append(li);
  }
  list.addEventListener('keydown', onRowKey);
  box.append(list);

  pager.hidden = false;
  pager.append(el('span', 'grow', pageLabel(data.offset, data.items.length, data.total)));
  claims.pager.button(pager, {
    label: 'Previous',
    size: 'xs',
    variant: 'outline',
    disabled: data.offset === 0 || slot.loading,
    onClick: () => setFilter({ offset: Math.max(0, data.offset - PAGE) }),
  });
  claims.pager.button(pager, {
    label: 'Next',
    size: 'xs',
    variant: 'outline',
    disabled: data.offset + data.items.length >= data.total || slot.loading,
    onClick: () => setFilter({ offset: data.offset + PAGE }),
  });
};

/** Arrow keys, Home and End move the focus between rows of a list. */
const onRowKey = (event: KeyboardEvent): void => {
  const list = event.currentTarget as HTMLElement;
  const rows = [...list.querySelectorAll<HTMLButtonElement>('.row')];
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  let next = -1;
  if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, index + 1);
  else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = rows.length - 1;
  if (next < 0) return;
  event.preventDefault();
  rows[next]?.focus();
};

const markSelectedRow = (): void => {
  for (const row of claims.rows.node.querySelectorAll<HTMLElement>('.row')) {
    if (row.dataset.id === model.selected) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
};

// ---------------------------------------------------------------------------
// Claims: detail
// ---------------------------------------------------------------------------

const selectClaim = (id: string): void => {
  if (model.selected !== id) model.editing = false;
  model.selected = id;
  model.pane = 'detail';
  claims.split.dataset.pane = 'detail';
  markSelectedRow();
  void loadDetail(true);
};

/** Opens a claim from another tab or from a link. */
const openClaim = (id: string): void => {
  setTab('claims');
  selectClaim(id);
  claims.detail.node.scrollTop = 0;
};

const loadDetail = (fresh = false): Promise<void> => {
  const id = model.selected;
  if (!id) return Promise.resolve();
  return load(model.detail, () => api<ClaimDetail>('GET', '/claim', { query: { id } }), renderDetail, !fresh);
};

const backToList = (): void => {
  model.pane = 'list';
  claims.split.dataset.pane = 'list';
  claims.rows.node.querySelector<HTMLElement>(`.row[data-id="${model.selected ?? ''}"]`)?.focus();
};

const section = (parent: Element, title: string): HTMLElement => {
  const s = el('section', 'section');
  s.append(el('h2', '', title));
  parent.append(s);
  return s;
};

const recordList = (parent: Element, pairs: Array<[string, Node | string | null | undefined]>): void => {
  const dl = el('dl', 'record');
  for (const [k, v] of pairs) {
    if (v === null || v === undefined || v === '') continue;
    dl.append(el('dt', '', k));
    const dd = el('dd');
    if (typeof v === 'string') dd.textContent = v;
    else dd.append(v);
    dl.append(dd);
  }
  parent.append(dl);
};

const mono = (text: string): HTMLElement => el('span', 'mono', text);

const renderDetail = (): void => {
  const region = claims.detail;
  const box = region.reset();
  if (!model.selected) {
    region.empty(box, 'No claim selected', 'Select a claim in the list to see its quote, evidence and history.');
    return;
  }
  const slot = model.detail;
  const d = el('article', 'detail');
  d.setAttribute('aria-label', 'Claim details');
  const backBtn = el('button', 'back-btn back');
  backBtn.type = 'button';
  backBtn.append(icon('back'), document.createTextNode('Back to list'));
  backBtn.addEventListener('click', backToList);
  d.append(backBtn);
  box.append(d);
  if (slot.error) {
    region.error(d, slot.error, () => void loadDetail(true));
    return;
  }
  const c = slot.data;
  if (!c || c.id !== model.selected) {
    region.spinner(d, 'Loading claim');
    return;
  }
  d.setAttribute('aria-busy', slot.loading ? 'true' : 'false');

  const top = el('div', 'detail-top');
  region.badge(top, STATUS_LABEL[c.status] ?? c.status, STATUS_TONE[c.status]);
  region.badge(top, KIND_LABEL[c.kind] ?? c.kind);
  if (c.pinned) region.badge(top, 'Pinned', 'primary');
  if (c.edited_at) region.badge(top, 'Edited', 'info');
  top.append(el('span', 'id', c.id));
  d.append(top);

  if (model.editing && c.status !== 'retracted') {
    renderEditForm(d, c, region);
  } else {
    const text = el('p', `claim-text${c.status === 'retracted' ? ' gone' : ''}`, c.text);
    d.append(text);
    const metrics = el('div', 'metrics');
    const metric = (label: string, value: number): void => {
      const m = meter(value, label);
      m.querySelector('span')?.replaceWith(el('b', '', fixed2(value)));
      const wrap = el('span', 'meter');
      wrap.append(document.createTextNode(label), m);
      metrics.append(wrap);
    };
    metric('Salience', c.salience);
    metric('Confidence', c.confidence);
    d.append(metrics);
    renderActions(d, c, region);
  }

  if (c.quote) {
    const s = section(d, 'Quote');
    s.append(el('blockquote', 'quote', c.quote));
  }

  if (c.evidence.length > 0) {
    const s = section(d, `Evidence (${c.evidence.length})`);
    const ul = el('ul', 'evidence');
    for (const ev of c.evidence) {
      const li = el('li');
      const head = el('div', 'ev-head');
      const title = el('div', 'ev-title');
      const info = c.sessions[ev.session_id];
      title.append(el('b', '', info?.title || 'Untitled session'));
      if (info?.directory) title.append(mono(info.directory));
      const ids = mono(`${ev.session_id} · ${ev.message_id}`);
      ids.style.display = 'block';
      title.append(ids);
      head.append(title);
      region.button(head, {
        label: 'Open session',
        size: 'xs',
        variant: 'ghost',
        onClick: () => void host.openSession(ev.session_id).catch((e: unknown) => toast('error', errorText(e))),
      });
      li.append(head);
      if (ev.quote && ev.quote !== c.quote) li.append(el('p', 'ev-quote', ev.quote));
      else if (ev.quote) li.append(el('p', 'ev-quote muted', 'Same as the quote above.'));
      ul.append(li);
    }
    s.append(ul);
  } else if (c.message_ids.length > 0) {
    const s = section(d, 'Messages');
    s.append(mono(c.message_ids.join(', ')));
  }

  const chain = c.supersedes_chain ?? [];
  if (c.superseded_by || c.supersedes_claim_id || chain.length > 0) {
    const s = section(d, 'History');
    const ul = el('ul', 'chain');
    if (c.superseded_by) {
      const li = el('li');
      li.append(el('span', 'muted', 'Replaced by'), linkButton(c.superseded_by, () => openClaim(c.superseded_by ?? ''), 'link mono'));
      ul.append(li);
    }
    if (c.supersedes_claim_id && !chain.some((link) => link.id === c.supersedes_claim_id)) {
      const li = el('li');
      li.append(el('span', 'muted', 'Replaces'), linkButton(c.supersedes_claim_id, () => openClaim(c.supersedes_claim_id ?? ''), 'link mono'));
      ul.append(li);
    }
    for (const link of chain) {
      const li = el('li');
      li.append(linkButton(link.id, () => openClaim(link.id), 'link mono'));
      const t = el('span', link.status === 'active' ? '' : 'muted', link.text);
      li.append(t);
      if (link.status !== 'active') region.badge(li, STATUS_LABEL[link.status] ?? link.status, STATUS_TONE[link.status]);
      ul.append(li);
    }
    s.append(ul);
  }

  if (c.entities.length > 0) {
    const s = section(d, 'Entities');
    const chips = el('div', 'chips');
    for (const e of c.entities) {
      const chip = el('button', 'chip');
      chip.type = 'button';
      chip.title = `Show claims about ${e.name}`;
      chip.append(document.createTextNode(e.name), el('small', '', e.type));
      chip.addEventListener('click', () => {
        backToList();
        setFilter({ entity: e.name });
      });
      chips.append(chip);
    }
    s.append(chips);
  }

  const s = section(d, 'Record');
  recordList(s, [
    ['Daily log', c.daily_citation ? mono(c.daily_citation) : null],
    ['Origin', c.origin],
    ['Observed', dateTime(c.observed_at)],
    ['Saved', dateTime(c.created_at)],
    ['Edited', dateTime(c.edited_at)],
    ['Mem0 id', c.mem0_id ? mono(c.mem0_id) : 'Not in Mem0'],
  ]);
};

const renderActions = (parent: Element, c: ClaimDetail, region: Region): void => {
  const bar = el('div', 'actions');
  parent.append(bar);
  if (c.status === 'retracted') {
    bar.append(el('span', 'muted', 'This claim was forgotten. It cannot be changed.'));
    return;
  }
  region.button(bar, {
    label: 'Edit',
    size: 'sm',
    variant: 'outline',
    onClick: () => {
      model.editing = true;
      renderDetail();
    },
  });
  const pinBtn = region.button(bar, {
    label: c.pinned ? 'Unpin' : 'Pin',
    size: 'sm',
    variant: 'outline',
    onClick: () => {
      pinBtn.update({ loading: true });
      void mutateClaim({ id: c.id, pinned: !c.pinned }, c.pinned ? 'Claim unpinned.' : 'Claim pinned.').finally(() => pinBtn.update({ loading: false }));
    },
  });
  if (c.status === 'superseded') {
    const restore = region.button(bar, {
      label: 'Restore',
      size: 'sm',
      variant: 'outline',
      onClick: () => {
        restore.update({ loading: true });
        void mutateClaim({ id: c.id, status: 'active' }, 'Claim restored. It is active again.').finally(() => restore.update({ loading: false }));
      },
    });
  }
  const push = el('span', 'push');
  bar.append(push);
  region.button(push, {
    label: 'Forget…',
    size: 'sm',
    variant: 'destructive',
    onClick: () => forgetDialog({ id: c.id, text: c.text, what: 'claim' }),
  });
};

const mutateClaim = async (body: Record<string, unknown>, message: string): Promise<boolean> => {
  try {
    await api<Claim>('POST', '/claim/edit', { body });
    model.editing = false;
    await afterChange(message);
    return true;
  } catch (error) {
    toast('error', errorText(error));
    return false;
  }
};

const rangeField = (parent: Element, label: string, value: number, onChange: (v: number) => void): void => {
  const id = `r-${label.toLowerCase()}`;
  const wrap = el('div', 'range');
  const lab = el('label');
  lab.htmlFor = id;
  const out = el('output', '', fixed2(value));
  out.htmlFor.add(id);
  lab.append(document.createTextNode(label), out);
  const input = el('input');
  input.type = 'range';
  input.id = id;
  input.min = '0';
  input.max = '1';
  input.step = '0.01';
  input.value = String(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fixed2(v);
    onChange(v);
  });
  wrap.append(lab, input);
  parent.append(wrap);
};

const kindSelect = (region: Region, parent: Element, value: Kind, onChange: (k: Kind) => void): void => {
  const box = el('div');
  parent.append(box);
  const handle = region.keep(
    mountSelect(box, {
      label: 'Kind',
      value,
      options: KINDS.map((k) => ({ id: k, label: KIND_LABEL[k] })),
      onChange: (id) => {
        onChange(id as Kind);
        handle.update({ value: id });
      },
    }),
  );
};

const renderEditForm = (parent: Element, c: ClaimDetail, region: Region): void => {
  const draft = { text: c.text, kind: c.kind, salience: c.salience, confidence: c.confidence };
  const form = el('form', 'edit');
  form.setAttribute('aria-label', 'Edit claim');
  parent.append(form);
  const textBox = el('div');
  form.append(textBox);
  const textField = region.keep(
    mountTextField(textBox, {
      label: 'Text',
      value: draft.text,
      multiline: true,
      rows: 3,
      helper: 'One sentence about the user. Line breaks become spaces.',
      onChange: (v) => {
        draft.text = v;
      },
    }),
  );
  const row = el('div', 'edit-row');
  form.append(row);
  kindSelect(region, row, draft.kind, (k) => {
    draft.kind = k;
  });
  rangeField(row, 'Salience', draft.salience, (v) => {
    draft.salience = v;
  });
  rangeField(row, 'Confidence', draft.confidence, (v) => {
    draft.confidence = v;
  });
  const err = el('div', 'form-error');
  err.setAttribute('role', 'alert');
  form.append(err);
  const bar = el('div', 'actions');
  form.append(bar);
  const cancel = (): void => {
    model.editing = false;
    renderDetail();
  };
  const save = region.button(bar, {
    label: 'Save',
    size: 'sm',
    onClick: () => void submit(),
  });
  region.button(bar, { label: 'Cancel', size: 'sm', variant: 'ghost', onClick: cancel });
  const submit = async (): Promise<void> => {
    const text = oneLine(draft.text);
    if (!text) {
      err.textContent = 'Enter the claim text.';
      textField.update({ error: 'Enter the claim text.' });
      return;
    }
    const body: Record<string, unknown> = { id: c.id };
    if (text !== c.text) body.text = text;
    if (draft.kind !== c.kind) body.kind = draft.kind;
    if (Math.abs(draft.salience - c.salience) > 0.0005) body.salience = draft.salience;
    if (Math.abs(draft.confidence - c.confidence) > 0.0005) body.confidence = draft.confidence;
    if (Object.keys(body).length === 1) {
      cancel();
      return;
    }
    err.textContent = '';
    save.update({ loading: true });
    try {
      await api<Claim>('POST', '/claim/edit', { body });
      model.editing = false;
      await afterChange('Claim saved.');
    } catch (error) {
      err.textContent = errorText(error);
      save.update({ loading: false });
    }
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  });
  queueMicrotask(() => form.querySelector<HTMLElement>('textarea, input')?.focus());
};

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/** A form check failed. The field shows the message, so the dialog does not repeat it. */
class FieldError extends Error {}

interface DialogSpec {
  title: string;
  lead: string;
  quote?: string;
  confirmLabel: string;
  destructive?: boolean;
  /** Builds the fields. Returns the action, which throws to keep the dialog open. */
  build: (form: HTMLElement, region: Region) => () => Promise<void>;
}

const openDialog = (spec: DialogSpec): void => {
  const dialog = el('dialog');
  const region = new Region(el('form', 'dlg'));
  const form = region.node;
  dialog.append(form);
  const titleId = `dlg-${Date.now()}`;
  const h = el('h2', '', spec.title);
  h.id = titleId;
  dialog.setAttribute('aria-labelledby', titleId);
  form.append(h, el('p', '', spec.lead));
  if (spec.quote) form.append(el('blockquote', '', spec.quote));
  const action = spec.build(form, region);
  const err = el('div', 'form-error');
  err.setAttribute('role', 'alert');
  form.append(err);
  const bar = el('div', 'dlg-actions');
  form.append(bar);
  let busy = false;
  const close = (): void => {
    dialog.close();
  };
  region.button(bar, { label: 'Cancel', variant: 'ghost', size: 'sm', onClick: close });
  const confirm = region.button(bar, {
    label: spec.confirmLabel,
    variant: spec.destructive ? 'destructive' : 'default',
    size: 'sm',
    onClick: () => void run(),
  });
  const run = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    err.textContent = '';
    confirm.update({ loading: true });
    try {
      await action();
      close();
    } catch (error) {
      if (error instanceof FieldError) form.querySelector<HTMLElement>('[aria-invalid=true], textarea, input')?.focus();
      else err.textContent = errorText(error);
    } finally {
      busy = false;
      confirm.update({ loading: false });
    }
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void run();
  });
  dialog.addEventListener('cancel', (event) => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    region.reset();
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
  form.querySelector<HTMLElement>('textarea, input')?.focus();
};

const forgetDialog = (target: { id: string; text: string; what: 'claim' | 'legacy' }): void => {
  openDialog({
    title: target.what === 'claim' ? 'Forget this claim?' : 'Forget this Mem0 entry?',
    lead:
      target.what === 'claim'
        ? 'You cannot undo this. musemem removes the claim, deletes it from Mem0, removes the text from the logs and dreams, and does not add it again.'
        : 'You cannot undo this. musemem deletes the entry from Mem0 and does not add it again.',
    quote: target.text,
    confirmLabel: 'Forget',
    destructive: true,
    build: (form, region) => {
      let reason = '';
      const box = el('div');
      form.append(box);
      const field = region.keep(
        mountTextField(box, {
          label: 'Reason',
          value: '',
          placeholder: 'For example: wrong, out of date, private',
          helper: 'musemem keeps the reason in its forget log.',
          onChange: (v) => {
            reason = v;
            field.update({ error: '' });
          },
        }),
      );
      return async () => {
        if (!oneLine(reason)) {
          field.update({ error: 'Enter a reason.' });
          throw new FieldError('Enter a reason.');
        }
        await api<TextResult>('POST', '/forget', { body: { id: target.id, reason: oneLine(reason) } });
        if (target.what === 'claim') {
          await afterChange('Claim forgotten.');
        } else {
          await afterLegacyChange('Mem0 entry forgotten.');
        }
      };
    },
  });
};

// ---------------------------------------------------------------------------
// Legacy (Mem0)
// ---------------------------------------------------------------------------

const legacy = {
  inner: el('div', 'page-inner'),
  count: el('span', 'muted'),
  list: new Region(el('div')),
  search: null as SearchFieldHandle | null,
};

const loadLegacy = (): Promise<void> => {
  model.stale.legacy = false;
  return load(model.legacy, () => api<LegacyList>('GET', '/legacy'), () => {
    renderLegacy();
    renderHeader();
  });
};

const afterLegacyChange = async (message: string): Promise<void> => {
  toast('success', message);
  model.stale.pinned = true;
  await Promise.allSettled([loadLegacy(), loadStats(), loadList()]);
};

const buildLegacy = (): void => {
  const page = el('div', 'page');
  page.append(legacy.inner);
  ui.views.legacy.append(page);
  const bar = el('div', 'toolbar');
  const searchBox = el('div');
  searchBox.style.flex = '1';
  searchBox.style.minWidth = '200px';
  bar.append(searchBox);
  legacy.search = mountSearchField(searchBox, {
    value: '',
    placeholder: 'Search Mem0 entries',
    label: 'Search Mem0 entries',
    onChange: (v) => {
      model.legacyQ = v;
      renderLegacy();
    },
  });
  legacy.count.setAttribute('aria-live', 'polite');
  bar.append(legacy.count);
  legacy.inner.append(
    bar,
    el('p', 'lead', 'These Mem0 entries have no claim. They come from other Mem0 clients or from the time before musemem. Adopt an entry to make it a claim, or forget it.'),
    legacy.list.node,
  );
};

const renderLegacy = (): void => {
  const region = legacy.list;
  const box = region.reset();
  const slot = model.legacy;
  const data = slot.data;
  if (slot.error) {
    legacy.count.textContent = '';
    region.error(box, slot.error, () => void loadLegacy());
    return;
  }
  if (!data) {
    legacy.count.textContent = '';
    region.spinner(box, 'Loading Mem0 entries');
    return;
  }
  const items = data.items.filter((item) => legacyMatches(item, model.legacyQ));
  legacy.count.textContent = model.legacyQ.trim() ? `${items.length} of ${data.total}` : plural(data.total, 'entry', 'entries');
  if (data.total === 0) {
    region.empty(box, 'Nothing to curate', 'Every Mem0 entry belongs to a claim.');
    return;
  }
  if (items.length === 0) {
    region.empty(box, 'No match', 'No entry has this text.');
    return;
  }
  const ul = el('ul', 'cards');
  ul.setAttribute('aria-label', 'Mem0 entries');
  for (const item of items) {
    const li = el('li', 'card');
    const main = el('div', 'card-main');
    main.append(el('p', 'card-text', item.text));
    const labels = el('div', 'labels');
    for (const [k, v] of legacyLabels(item)) {
      const span = el('span');
      span.append(document.createTextNode(`${k} `), el('b', '', v));
      labels.append(span);
    }
    if (item.created_at) {
      const t = el('span', '', shortDate(item.created_at));
      t.title = dateTime(item.created_at);
      labels.append(t);
    }
    main.append(labels);
    li.append(main);
    const actions = el('div', 'card-actions');
    region.button(actions, { label: 'Adopt…', size: 'xs', variant: 'outline', onClick: () => adoptDialog(item) });
    region.button(actions, { label: 'Forget…', size: 'xs', variant: 'ghost', onClick: () => forgetDialog({ id: item.id, text: item.text, what: 'legacy' }) });
    li.append(actions);
    ul.append(li);
  }
  box.append(ul);
};

const adoptDialog = (item: LegacyItem): void => {
  const tag = typeof item.metadata.tag === 'string' ? item.metadata.tag : '';
  const draft = { text: oneLine(item.text), kind: ((KINDS as readonly string[]).includes(tag) ? tag : 'fact') as Kind, salience: 0.8 };
  openDialog({
    title: 'Adopt as a claim',
    lead: 'musemem saves this text as a new claim, then deletes the old Mem0 entry. You can change the text first.',
    confirmLabel: 'Adopt',
    build: (form, region) => {
      const box = el('div');
      form.append(box);
      const field = region.keep(
        mountTextField(box, {
          label: 'Text',
          value: draft.text,
          multiline: true,
          rows: 3,
          onChange: (v) => {
            draft.text = v;
            field.update({ error: '' });
          },
        }),
      );
      const row = el('div', 'edit-row');
      form.append(row);
      kindSelect(region, row, draft.kind, (k) => {
        draft.kind = k;
      });
      rangeField(row, 'Salience', draft.salience, (v) => {
        draft.salience = v;
      });
      return async () => {
        const text = oneLine(draft.text);
        if (!text) {
          field.update({ error: 'Enter the text.' });
          throw new FieldError('Enter the text.');
        }
        const result = await api<AdoptResult>('POST', '/legacy/adopt', { body: { id: item.id, text, kind: draft.kind, salience: draft.salience } });
        await afterLegacyChange(result.claim_id ? `Adopted as ${result.claim_id}.` : 'Adopted.');
      };
    },
  });
};

// ---------------------------------------------------------------------------
// Dreams
// ---------------------------------------------------------------------------

const dreams = {
  wrap: el('div', 'dreams'),
  nav: new Region(el('nav', 'nav')),
  doc: new Region(el('div', 'doc-inner')),
  docScroll: el('div', 'doc'),
};

const mdOptions = {
  onClaim: openClaim,
  onLink: (href: string) => void host.openUrl(href).catch((e: unknown) => toast('error', errorText(e))),
};

const loadDreams = (): Promise<void> => {
  model.stale.dreams = false;
  return load(model.dreams, () => api<DreamsIndex>('GET', '/dreams'), () => {
    renderDreamsNav();
    renderDreamDoc();
  });
};

const setDreamView = (view: DreamView): void => {
  model.dreamView = view;
  renderDreamsNav();
  dreams.docScroll.scrollTop = 0;
  if (view !== 'synthesis' && view !== 'state') {
    void load(model.dreamDoc, () => api<DreamFile>('GET', '/dream', { query: { date: view } }), renderDreamDoc, false);
  } else {
    renderDreamDoc();
  }
};

const threadsOf = (index: DreamsIndex | null): RepairThread[] => {
  const raw = index?.companions.REPAIR_THREADS;
  return Array.isArray(raw) ? (raw.filter((t) => t && typeof t === 'object') as RepairThread[]) : [];
};

const renderDreamsNav = (): void => {
  const region = dreams.nav;
  const nav = region.reset();
  nav.setAttribute('aria-label', 'Dream documents');
  const index = model.dreams.data;
  const item = (id: DreamView, label: string, meta?: string): void => {
    const b = el('button', 'row');
    b.type = 'button';
    if (model.dreamView === id) b.setAttribute('aria-current', 'true');
    b.append(el('span', 'grow', label));
    if (meta) b.append(el('span', 'muted', meta));
    b.addEventListener('click', () => setDreamView(id));
    nav.append(b);
  };
  item('synthesis', 'Synthesis');
  const open = threadsOf(index).filter((t) => (t.status ?? 'open') === 'open').length;
  item('state', 'State and threads', open > 0 ? `${open} open` : undefined);
  nav.append(el('h2', '', 'Dream files'));
  for (const date of index?.dates ?? []) item(date, date);
  if (index && index.dates.length === 0) nav.append(el('div', 'nav-note', 'No dream files yet.'));
};

const valueBlock = (parent: Element, value: unknown): void => {
  if (value === null || value === undefined || value === '') return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    parent.append(el('p', '', String(value)));
    return;
  }
  if (Array.isArray(value)) {
    const ul = el('ul');
    for (const v of value) {
      const li = el('li');
      if (v && typeof v === 'object') valueBlock(li, v);
      else li.textContent = String(v);
      ul.append(li);
    }
    parent.append(ul);
    return;
  }
  const pairs = Object.entries(value as Record<string, unknown>).map(([k, v]): [string, string] => [humanKey(k), typeof v === 'object' ? JSON.stringify(v) : String(v)]);
  recordList(parent, pairs);
};

const renderState = (box: HTMLElement, region: Region, index: DreamsIndex): void => {
  box.append(el('h2', 'doc-title', 'State and threads'));
  const state = index.companions.ALIGNMENT_STATE as Record<string, unknown> | null;
  const updated = state && typeof state.updated === 'string' ? state.updated : null;
  box.append(el('p', 'muted', updated ? `Updated ${dateTime(updated)} by the dream run.` : 'The nightly dream run writes this data.'));

  const threads = threadsOf(index);
  const s1 = section(box, `Repair threads (${threads.length})`);
  if (threads.length === 0) {
    s1.append(el('p', 'muted', 'No repair threads.'));
  } else {
    const ul = el('ul', 'threads');
    const sorted = [...threads].sort((a, b) => Number((b.status ?? 'open') === 'open') - Number((a.status ?? 'open') === 'open'));
    for (const t of sorted) {
      const status = String(t.status ?? 'open');
      const li = el('li', 'thread');
      li.dataset.open = String(status === 'open');
      const head = el('div', 'thread-head');
      head.append(el('b', '', String(t.title ?? t.id ?? 'Untitled thread')));
      region.badge(head, status === 'open' ? 'Open' : status === 'resolved' ? 'Resolved' : humanKey(status), status === 'open' ? 'warning' : status === 'resolved' ? 'success' : undefined);
      li.append(head);
      const line = (label: string, value: unknown): void => {
        if (typeof value !== 'string' || !value) return;
        const p = el('p');
        p.append(el('span', 'k', label), renderInlineText(value, mdOptions));
        li.append(p);
      };
      line('Evidence', t.evidence);
      line('Next step', t.next_step);
      ul.append(li);
    }
    s1.append(ul);
  }

  if (state) {
    for (const [key, value] of Object.entries(state)) {
      if (key === 'updated') continue;
      const s = section(box, humanKey(key));
      valueBlock(s, value);
    }
  }

  const history = index.companions.PROGRESSION_HISTORY;
  const s3 = section(box, 'Progression');
  if (Array.isArray(history) && history.length > 0) {
    const ol = el('ol', 'timeline');
    for (const h of [...history].reverse() as Array<Record<string, unknown>>) {
      const li = el('li');
      const time = el('time', '', String(h.date ?? ''));
      time.dateTime = String(h.date ?? '');
      li.append(time, el('span', '', String(h.summary ?? '')));
      ol.append(li);
    }
    s3.append(ol);
  } else {
    s3.append(el('p', 'muted', 'No progression history yet.'));
  }
};

const renderDreamDoc = (): void => {
  const region = dreams.doc;
  const box = region.reset();
  const slot = model.dreams;
  if (slot.error) {
    region.error(box, slot.error, () => void loadDreams());
    return;
  }
  const index = slot.data;
  if (!index) {
    region.spinner(box, 'Loading dreams');
    return;
  }
  const view = model.dreamView;
  if (view === 'synthesis') {
    if (!index.synthesis.trim()) region.empty(box, 'No synthesis yet', 'The nightly dream run writes it.');
    else box.append(renderMarkdown(index.synthesis, mdOptions));
    return;
  }
  if (view === 'state') {
    renderState(box, region, index);
    return;
  }
  const doc = model.dreamDoc;
  if (doc.error) {
    region.error(box, doc.error, () => setDreamView(view));
    return;
  }
  if (!doc.data || doc.data.date !== view) {
    region.spinner(box, 'Loading dream');
    return;
  }
  box.append(renderMarkdown(doc.data.markdown, mdOptions));
};

const buildDreams = (): void => {
  dreams.docScroll.append(dreams.doc.node);
  dreams.nav.node.addEventListener('keydown', onRowKey);
  dreams.wrap.append(dreams.nav.node, dreams.docScroll);
  ui.views.dreams.append(dreams.wrap);
};

// ---------------------------------------------------------------------------
// Pinned
// ---------------------------------------------------------------------------

const pinned = {
  inner: el('div', 'page-inner'),
  editor: new Region(el('div', 'pinned-editor')),
  claims: new Region(el('div')),
  claimsTitle: el('h2', '', 'Pinned claims'),
};

const loadPinned = (): Promise<void> => {
  model.stale.pinned = false;
  const a = load(model.pinnedText, () => api<PinnedText>('GET', '/pinned-text'), renderPinnedEditor);
  const b = load(
    model.pinnedClaims,
    () => api<ClaimList>('GET', '/claims', { query: { status: 'all', pinned: 'true', sort: 'salience', limit: '200' } }),
    renderPinnedClaims,
  );
  return Promise.allSettled([a, b]).then(() => undefined);
};

const renderPinnedEditor = (): void => {
  const region = pinned.editor;
  const box = region.reset();
  const slot = model.pinnedText;
  if (slot.error && !slot.data) {
    region.error(box, slot.error, () => void loadPinned());
    return;
  }
  if (!slot.data) {
    region.spinner(box, 'Loading the pinned block');
    return;
  }
  const saved = slot.data.pinned_text;
  const area = el('textarea');
  area.id = 'pinned-text';
  area.value = model.pinnedDraft ?? saved;
  area.spellcheck = true;
  area.setAttribute('aria-describedby', 'pinned-help pinned-count');
  const label = el('label', 'sr-only', 'Pinned block text');
  label.htmlFor = 'pinned-text';
  const foot = el('div', 'editor-foot');
  const count = el('span', 'count');
  count.id = 'pinned-count';
  count.setAttribute('aria-live', 'polite');
  foot.append(count);
  const revert = region.button(foot, {
    label: 'Revert',
    size: 'sm',
    variant: 'ghost',
    onClick: () => {
      model.pinnedDraft = null;
      renderPinnedEditor();
    },
  });
  const save = region.button(foot, { label: 'Save', size: 'sm', onClick: () => void submit() });
  const sync = (): void => {
    const length = [...area.value].length;
    const dirty = area.value !== saved;
    count.textContent = `${length.toLocaleString()} / ${PINNED_MAX.toLocaleString()} characters${dirty ? ' · not saved' : ''}`;
    count.classList.toggle('over', length > PINNED_MAX);
    save.update({ disabled: !dirty || length > PINNED_MAX, loading: model.pinnedSaving });
    revert.update({ disabled: !dirty || model.pinnedSaving });
  };
  const submit = async (): Promise<void> => {
    if (area.value === saved || [...area.value].length > PINNED_MAX || model.pinnedSaving) return;
    model.pinnedSaving = true;
    sync();
    try {
      const result = await api<PinnedText>('POST', '/pinned-text', { body: { text: area.value } });
      model.pinnedText.data = result;
      model.pinnedDraft = null;
      toast('success', 'Pinned block saved.');
    } catch (error) {
      toast('error', errorText(error));
    }
    model.pinnedSaving = false;
    renderPinnedEditor();
  };
  area.addEventListener('input', () => {
    model.pinnedDraft = area.value;
    sync();
  });
  area.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && (event.key === 's' || event.key === 'Enter')) {
      event.preventDefault();
      void submit();
    }
  });
  box.append(label, area, foot);
  sync();
};

const renderPinnedClaims = (): void => {
  const region = pinned.claims;
  const box = region.reset();
  const slot = model.pinnedClaims;
  pinned.claimsTitle.textContent = slot.data ? `Pinned claims (${slot.data.total})` : 'Pinned claims';
  if (slot.error) {
    region.error(box, slot.error, () => void loadPinned());
    return;
  }
  if (!slot.data) {
    region.spinner(box, 'Loading pinned claims');
    return;
  }
  if (slot.data.items.length === 0) {
    region.empty(box, 'No pinned claims', 'Use Pin on a claim in the Claims tab.');
    return;
  }
  const ul = el('ul', 'cards');
  ul.setAttribute('aria-label', 'Pinned claims');
  for (const c of slot.data.items) {
    const li = el('li', 'card');
    const main = el('div', 'card-main');
    main.append(el('p', 'card-text', c.text));
    const labels = el('div', 'labels');
    labels.append(el('span', '', KIND_LABEL[c.kind] ?? c.kind), el('span', '', `salience ${fixed2(c.salience)}`));
    if (c.status !== 'active') labels.append(el('span', '', STATUS_LABEL[c.status] ?? c.status));
    labels.append(el('span', 'mono', c.id));
    main.append(labels);
    li.append(main);
    const actions = el('div', 'card-actions');
    region.button(actions, { label: 'Open', size: 'xs', variant: 'ghost', onClick: () => openClaim(c.id) });
    const unpin = region.button(actions, {
      label: 'Unpin',
      size: 'xs',
      variant: 'outline',
      onClick: () => {
        unpin.update({ loading: true });
        void mutateClaim({ id: c.id, pinned: false }, 'Claim unpinned.').then((ok) => {
          if (!ok) unpin.update({ loading: false });
        });
      },
    });
    li.append(actions);
    ul.append(li);
  }
  box.append(ul);
};

const buildPinned = (): void => {
  const page = el('div', 'page');
  page.append(pinned.inner);
  ui.views.pinned.append(page);
  const s1 = el('section', 'section');
  s1.style.paddingTop = '0';
  s1.append(el('h2', '', 'Pinned block'));
  const help = el('p', 'lead', 'You write this block by hand. It stays at the top of ~/MEMORY.md, and musemem does not change it. Press Ctrl+S to save.');
  help.id = 'pinned-help';
  s1.append(help, pinned.editor.node);
  const s2 = el('section', 'section');
  s2.style.paddingTop = '24px';
  s2.append(pinned.claimsTitle, pinned.claims.node);
  pinned.inner.append(s1, s2);
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const build = (): void => {
  const style = el('style', '', CSS);
  document.head.append(style);
  const root = document.querySelector('#root');
  if (!root) throw new Error('Missing #root');

  ui.head.append(el('h1', '', 'Memory'), ui.counts.node);
  ui.refresh = iconButton('refresh', 'Refresh', () => void refreshAll());
  ui.runs.append(ui.runsText, ui.refresh);
  ui.head.append(ui.runs);
  ui.tabs = mountTabs(ui.tabsBox, { items: tabItems(), activeId: model.tab, onChange: (id) => setTab(id as Tab) });

  claims.split.dataset.pane = 'list';
  buildFilters();
  claims.listPane.append(claims.filters, claims.resultLine, claims.rows.node, claims.pager.node);
  claims.detailPane.append(claims.detail.node);
  claims.split.append(claims.listPane, claims.detailPane);
  ui.views.claims.append(claims.split);
  buildLegacy();
  buildDreams();
  buildPinned();

  for (const [id, node] of Object.entries(ui.views)) {
    node.id = `view-${id}`;
    node.setAttribute('aria-label', VIEW_LABEL[id as Tab]);
    node.hidden = id !== model.tab;
  }
  ui.app.append(ui.head, ui.tabsBox, ui.banners.node, ...Object.values(ui.views));
  root.replaceChildren(ui.app);

  const measure = (): void => {
    ui.app.dataset.layout = ui.app.clientWidth < 760 ? 'narrow' : 'wide';
  };
  new ResizeObserver(measure).observe(ui.app);
  measure();

  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (event.key === '/' && !typing && !document.querySelector('dialog[open]')) {
      const input = (model.tab === 'claims' ? claims.filters : model.tab === 'legacy' ? legacy.inner : null)?.querySelector('input');
      if (input) {
        event.preventDefault();
        input.focus();
      }
    } else if (event.key === 'Escape' && !typing && model.tab === 'claims' && model.pane === 'detail' && ui.app.dataset.layout === 'narrow') {
      backToList();
    }
  });

  renderHeader();
  renderList();
  renderDetail();
  void loadStats();
  void loadList();
  // The legacy count needs a Mem0 request. Load it after the first view.
  setTimeout(() => {
    if (model.stale.legacy) void loadLegacy();
  }, 400);
};

let mounted = false;
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (mounted) return;
  mounted = true;
  void host.storage
    .get('tab')
    .catch(() => undefined)
    .then((tab) => {
      if (tab === 'claims' || tab === 'legacy' || tab === 'dreams' || tab === 'pinned') model.tab = tab;
      build();
      if (model.tab !== 'claims') setTab(model.tab);
    });
});
