// URL shortener: cutt.ly, tinyurl.com or dub.co, with API keys from settings.
// None of the APIs reliably report remaining quota, so links are counted locally
// per service per calendar month ("shortCounts") and kept in "shortHistory".

const shortenerHandlers = {
  shorten: ({ service, url }) => shorten(service, url),
  clearShortHistory: () => chrome.storage.local.set({ shortHistory: [] }),
};

const HISTORY_LIMIT = 100;

const CUTTLY_ERRORS = {
  1: "That link is already shortened",
  2: "That isn't a valid link",
  3: "That short name is taken",
  4: "Invalid cutt.ly API key",
  5: "cutt.ly rejected the link",
  6: "cutt.ly blocks links from this domain",
  8: "cutt.ly monthly limit reached",
};

async function shorten(service, url) {
  const info = TT.SHORTENERS[service];
  if (!info) throw new Error("Unknown shortener");
  if (!/^https?:\/\//i.test(url || "")) throw new Error("Only http(s) pages can be shortened");
  const { shortener } = await TT.getSettings();
  const key = shortener.keys[service]?.trim();
  if (!key) throw new Error(`Add your ${info.label} API key in Settings → URL shortener`);

  const short = await SHORTEN[service](key, url);
  const month = TT.monthKey();
  const { shortCounts = {}, shortHistory = [] } = await chrome.storage.local.get(["shortCounts", "shortHistory"]);
  const counts = shortCounts.month === month ? shortCounts : { month };
  counts[service] = (counts[service] || 0) + 1;
  shortHistory.unshift({ service, short, url, at: Date.now() });
  await chrome.storage.local.set({ shortCounts: counts, shortHistory: shortHistory.slice(0, HISTORY_LIMIT) });
  return { short, count: counts[service] };
}

const SHORTEN = {
  async cuttly(key, url) {
    const res = await fetch(`https://cutt.ly/api/api.php?key=${encodeURIComponent(key)}&short=${encodeURIComponent(url)}`);
    const data = await res.json().catch(() => null);
    const status = data?.url?.status;
    if (status === 7 && data.url.shortLink) return data.url.shortLink;
    throw new Error(CUTTLY_ERRORS[status] || `cutt.ly error (${res.status})`);
  },
  async tinyurl(key, url) {
    const res = await fetch("https://api.tinyurl.com/create", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url, domain: "tinyurl.com" }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.data?.tiny_url) return data.data.tiny_url;
    throw new Error(data?.errors?.[0] || (res.status === 401 ? "Invalid TinyURL API token" : `TinyURL error (${res.status})`));
  },
  async dub(key, url) {
    const res = await fetch("https://api.dub.co/links", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.shortLink) return data.shortLink;
    throw new Error(data?.error?.message || (res.status === 401 ? "Invalid dub.co API key" : `dub.co error (${res.status})`));
  },
};
