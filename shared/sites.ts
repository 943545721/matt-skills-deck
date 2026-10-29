/**
 * 客户端下的「站点」：同一个客户端准备几份接入地址 + 凭证，**同一时刻只有一条生效**。
 *
 * 为什么不是「一个站点 = 一个客户端条目」：用户的心智是 `claude` 一个客户端，
 * 手上却有好几条线路（各自地址与凭证）。做成平级客户端会把列表撑开、每条还得重声明一遍模型。
 *
 * 生效是怎么落地的：宿主那边 `agents.providers.<id>.env` 是**一个客户端一份**，
 * 没有轮询、没有故障转移。所以「启用某条站点」= 把这条的地址与凭证写进客户端自己的 env，
 * 这个客户端的**所有新会话**都走它；换一条再点启用即可。已开的会话不追溯。
 *
 * 这个文件只放纯函数与形状：不读文件、不碰宿主、不打日志（凭证明文只活在服务端）。
 */

/** 一条站点。`credential` 是明文，只在服务端与写盘路径里出现，永不出线上契约。 */
export interface Site {
  id: string;
  label?: string;
  baseUrl: string;
  /** 空串 = 沿用客户端自己已有凭据，只换地址。 */
  credential: string;
  updatedAt?: string;
}

/** 磁盘上的形状：客户端 id → 它的站点表（按加入顺序）。 */
export interface SiteBook {
  version: 1;
  providers: Record<string, Site[]>;
}

export const EMPTY_SITE_BOOK: SiteBook = { version: 1, providers: {} };

/** 站点 id 的形状：小写字母开头，只含小写字母 / 数字 / 连字符。 */
const SITE_ID_SHAPE = /^[a-z][a-z0-9-]{0,31}$/;

/** 归一化用户输入的 id：小写、空格转连字符；非法字符直接压平（服务端仍会再校验一遍）。 */
export function normalizeSiteId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/** id 为什么不合法；合法就回 null。重名由 `taken` 判（改自己不算重名）。 */
export function siteIdProblem(rawId: string, taken: readonly string[]): string | null {
  const id = rawId.trim();
  if (!id) return "站点 id 不能为空";
  if (!SITE_ID_SHAPE.test(id)) return `站点 id 只能用${"小写字母开头、小写字母/数字/连字符"}，最多 32 个字符：${id}`;
  if (taken.includes(id)) return `已经有站点 ${id}：换个 id，或者直接改那一条`;
  return null;
}

/** 地址归一：去掉首尾空白与尾部斜杠（`https://a.test/` 与 `https://a.test` 是同一条）。 */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** 地址为什么不合法；合法就回 null。只认 http/https——其余协议宿主起不来。 */
export function siteUrlProblem(raw: string): string | null {
  const text = normalizeBaseUrl(raw);
  if (!text) return "接入地址不能为空";
  if (!/^https?:\/\//i.test(text)) return `接入地址只支持 http/https：${text}`;
  if (!/^https?:\/\/[^\s/?#]+/i.test(text)) return `接入地址不像一个 URL：${text}`;
  return null;
}

/** 一个客户端下的站点表；没有就是空数组。 */
export function sitesOf(book: SiteBook, provider: string): Site[] {
  return book.providers[provider] ?? [];
}

/** 加一条 / 覆盖同 id 的一条（不可变：返回新书，不动入参）。 */
export function withSite(book: SiteBook, provider: string, site: Site): SiteBook {
  const current = sitesOf(book, provider);
  const index = current.findIndex((item) => item.id === site.id);
  const next = index >= 0 ? current.map((item, at) => (at === index ? site : item)) : [...current, site];
  return { ...book, providers: { ...book.providers, [provider]: next } };
}

/** 删一条；删到最后一条就把这个客户端整条拿掉，不留空壳。 */
export function withoutSite(book: SiteBook, provider: string, siteId: string): SiteBook {
  const next = sitesOf(book, provider).filter((item) => item.id !== siteId);
  const providers = { ...book.providers };
  if (next.length) providers[provider] = next;
  else delete providers[provider];
  return { ...book, providers };
}

/**
 * 现在生效的是哪一条。
 *
 * 判据是**宿主自己配置里的值**，不是我们另存一个开关：多存一份状态就会漂移
 * （用户在 Paseo 里手改了地址、站点表却仍然指着老的一条）。
 * 地址相同且（站点没存凭证，或凭证与宿主一致）才算生效——地址一样、凭证不一样时
 * 会话用的是另一把钥匙，说「就是这条」是骗人。
 */
export function enabledSiteOf(
  sites: readonly Site[],
  host: { baseUrl: string | null; credential: string | null },
): Site | null {
  const hostUrl = host.baseUrl ? normalizeBaseUrl(host.baseUrl) : "";
  if (!hostUrl) return null;
  const sameUrl = sites.filter((site) => normalizeBaseUrl(site.baseUrl) === hostUrl);
  if (!sameUrl.length) return null;
  const hostCredential = (host.credential ?? "").trim();
  return (
    sameUrl.find((site) => site.credential.trim() && site.credential.trim() === hostCredential) ??
    sameUrl.find((site) => !site.credential.trim()) ??
    null
  );
}

/**
 * 读到的任何东西都当外部输入：坏条目丢掉而不是整份作废（一条手写坏的站点
 * 不该让整个客户端表消失），但要能把「丢了几条」报出去——调用方按数量差告警。
 */
export function normalizeBook(raw: unknown): { book: SiteBook; dropped: number } {
  const empty: { book: SiteBook; dropped: number } = { book: EMPTY_SITE_BOOK, dropped: 0 };
  const root = asRecord(raw);
  if (!root) return empty;
  const providersInput = asRecord(root.providers);
  if (!providersInput) return empty;
  const providers: Record<string, Site[]> = {};
  let dropped = 0;
  for (const [provider, value] of Object.entries(providersInput)) {
    const list = Array.isArray(value) ? value : null;
    if (!list) {
      dropped += 1;
      continue;
    }
    const sites: Site[] = [];
    for (const item of list) {
      const site = normalizeSite(item);
      if (!site) {
        dropped += 1;
        continue;
      }
      if (sites.some((existing) => existing.id === site.id)) {
        dropped += 1;
        continue;
      }
      sites.push(site);
    }
    if (sites.length) providers[provider] = sites;
  }
  return { book: { version: 1, providers }, dropped };
}

function normalizeSite(raw: unknown): Site | null {
  const item = asRecord(raw);
  if (!item) return null;
  const id = typeof item.id === "string" ? normalizeSiteId(item.id) : "";
  if (!id || !SITE_ID_SHAPE.test(id)) return null;
  const baseUrl = typeof item.baseUrl === "string" ? normalizeBaseUrl(item.baseUrl) : "";
  if (siteUrlProblem(baseUrl)) return null;
  const label = typeof item.label === "string" && item.label.trim() ? item.label.trim().slice(0, 120) : undefined;
  const credential = typeof item.credential === "string" ? item.credential.trim() : "";
  const updatedAt =
    typeof item.updatedAt === "string" && !Number.isNaN(Date.parse(item.updatedAt)) ? item.updatedAt : undefined;
  return {
    id,
    ...(label ? { label } : {}),
    baseUrl,
    credential,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
