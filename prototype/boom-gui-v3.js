(() => {
"use strict";

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>"]/g, char =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[char]));

/** Only these schemes may become a link, so a `javascript:` URL stays inert text. */
const MD_SAFE_HREF = /^(?:https?:\/\/|mailto:)[^"'<>\s]+$/i;

/**
 * Inline formatting. The input must ALREADY be escaped.
 *
 * NOTES.md and WRITEUP.md carry model output and challenge text, both untrusted — a web challenge
 * legitimately contains things like `<img onerror=...>`, which must render as visible characters
 * rather than execute. Escaping happens first and this function only ever emits tags it builds
 * itself, so nothing in the source can become live markup.
 */
function mdInline(escaped) {
  return escaped
    .replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, text, href) =>
      MD_SAFE_HREF.test(href)
        ? `<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>`
        : whole);
}

/**
 * Render the markdown subset NOTES.md and WRITEUP.md actually use: headings, fenced code, lists,
 * quotes, rules, paragraphs. Deliberately not CommonMark — a bundled parser would be a dependency to
 * audit, and the CSP is `script-src 'self'` so a CDN copy could not load anyway.
 */
function renderMarkdown(text) {
  const source = String(text ?? "");
  if (!source.trim()) return "";
  const out = [];
  let list = null;
  let para = [];
  let fence = null;
  let code = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${mdInline(esc(para.join(" ")))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const openList = kind => {
    if (list !== kind) {
      closeList();
      out.push(`<${kind}>`);
      list = kind;
    }
  };
  const flushCode = () => {
    out.push(`<pre class="md-code"><code>${esc(code.join("\n"))}</code></pre>`);
    fence = null;
    code = [];
  };

  for (const raw of source.split(/\r?\n/)) {
    const fenceMatch = /^\s*(```+|~~~+)(.*)$/.exec(raw);
    if (fence) {
      if (fenceMatch && raw.trim().startsWith(fence)) flushCode();
      else code.push(raw);
      continue;
    }
    if (fenceMatch) {
      flushPara();
      closeList();
      fence = fenceMatch[1].slice(0, 3);
      continue;
    }
    if (!raw.trim()) {
      flushPara();
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level} class="md-h">${mdInline(esc(heading[2]))}</h${level}>`);
      continue;
    }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(raw)) {
      flushPara();
      closeList();
      out.push("<hr>");
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      flushPara();
      closeList();
      out.push(`<blockquote>${mdInline(esc(quote[1]))}</blockquote>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(raw);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
    if (bullet || ordered) {
      flushPara();
      openList(bullet ? "ul" : "ol");
      out.push(`<li>${mdInline(esc((bullet || ordered)[1]))}</li>`);
      continue;
    }
    para.push(raw.trim());
  }
  // An unterminated fence still shows its content instead of silently dropping the tail.
  if (fence) flushCode();
  flushPara();
  closeList();
  return out.join("");
}

let snapshot = null;
let challenges = [];
let selected = "";
let filter = "";
/** Categories the user collapsed in the queue. Session-only; not worth persisting server-side. */
const collapsed = new Set();

/** Quote a value for use inside a CSS attribute selector; slugs may contain dots or brackets. */
const cssEscape = value => window.CSS?.escape
  ? window.CSS.escape(value)
  : String(value).replace(/["\\]/g, "\\$&");
let menuFor = null;
let deleteTarget = null;
let providerCatalog = [];
let providerSelected = "";
let providerDraft = null;
let providerNew = false;
let mcpCatalog = [];
let mcpSelected = "";
let mcpDraft = null;
let mcpNew = false;
let platformCatalog = [];
let platformSelected = "";
let platformRemoteCatalog = {items:[], page:0, pageSize:50, total:0, categories:[], difficulties:[]};
let platformRemoteSelection = {all:false, ids:new Set()};
let platformCatalogLoaded = false;
let armorPromptCatalog = [];
let armorPromptDraft = [];
let settingsLoaded = false;
let refreshTimer = 0;
let detailRequest = 0;
let toastTimer = 0;
let nativeRequestID = 0;
const nativeDirectoryRequests = new Map();

window.__boomNativeDirectoryResult = result => {
  const resolve = nativeDirectoryRequests.get(result?.id);
  if (!resolve) return;
  nativeDirectoryRequests.delete(result.id);
  resolve(typeof result.path === "string" && result.path ? result.path : null);
};

function chooseDirectory({title, initial = ""}) {
  const bridge = window.webkit?.messageHandlers?.boom;
  if (!bridge) return Promise.resolve(prompt(title, initial));
  const id = `directory-${++nativeRequestID}`;
  return new Promise(resolve => {
    nativeDirectoryRequests.set(id, resolve);
    try {
      bridge.postMessage({type:"pickDirectory", id, title, initial});
    } catch {
      nativeDirectoryRequests.delete(id);
      resolve(prompt(title, initial));
    }
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body
      ? {"Content-Type":"application/json", ...(options.headers || {})}
      : options.headers,
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `${response.status} ${response.statusText}`);
  return value;
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("on"), 2200);
}

function copy(text, message) {
  (navigator.clipboard?.writeText(text) ?? Promise.reject())
    .then(() => toast(message))
    .catch(() => toast("复制失败，请手动选中"));
}

function shortModel(model) {
  const tail = String(model || "—").split("/").pop();
  return tail.length > 22 ? `${tail.slice(0, 19)}…` : tail;
}

function modelOptions() {
  if (!snapshot) return [];
  const current = new Set([
    snapshot.settings.economyModel,
    snapshot.settings.strongModel,
    ...(snapshot.settings.consultModels || []),
  ]);
  const connected = snapshot.models.filter(model => model.connected);
  const source = connected.length ? connected : snapshot.models.slice(0, 200);
  const models = [...source];
  for (const id of current) {
    if (id && !models.some(model => model.id === id))
      models.unshift({id, name:id, connected:false});
  }
  return models;
}

function syncModelSelects() {
  const models = modelOptions();
  const currentEconomy = $("#economyModel").value || snapshot.settings.economyModel;
  const currentStrong = $("#strongModel").value || snapshot.settings.strongModel;
  const selectedConsult = new Set(
    $("#consultModels").selectedOptions.length
      ? [...$("#consultModels").selectedOptions].map(option => option.value)
      : (snapshot.settings.consultModels || []));
  const options = models.map(model =>
    `<option value="${esc(model.id)}">${model.connected ? "●" : "○"} ${esc(model.name || model.id)}</option>`
  ).join("");
  $("#economyModel").innerHTML = options;
  $("#strongModel").innerHTML = options;
  $("#consultModels").innerHTML = options;
  $("#economyModel").value = models.some(model => model.id === currentEconomy)
    ? currentEconomy : (models[0]?.id || snapshot.settings.economyModel);
  $("#strongModel").value = models.some(model => model.id === currentStrong)
    ? currentStrong : (models[0]?.id || snapshot.settings.strongModel);
  [...$("#consultModels").options].forEach(option => {
    option.selected = selectedConsult.has(option.value);
  });
}

function syncEnvironmentSelect() {
  if (!snapshot) return;
  const store = snapshot.environments || {profiles:[]};
  const selected = $("#pythonEnvironment").value || store.defaultProfileId || "";
  $("#pythonEnvironment").innerHTML = [
    `<option value="">— 请选择现有环境 —</option>`,
    ...store.profiles.map(profile =>
      `<option value="${esc(profile.id)}"${profile.status === "ready" ? "" : " disabled"}>${
        profile.status === "ready" ? "●" : "○"} ${esc(profile.displayName)} · Python ${esc(profile.pythonVersion)} · ${esc(profile.installPolicy)}</option>`),
  ].join("");
  $("#pythonEnvironment").value = store.profiles.some(profile => profile.id === selected)
    ? selected : (store.defaultProfileId || "");
  const profile = store.profiles.find(item => item.id === $("#pythonEnvironment").value);
  $("#environmentStatus").textContent = profile
    ? `${profile.kind} · ${profile.architecture} · 指纹 ${profile.fingerprint.slice(0, 16)}… · 安装策略 ${profile.installPolicy}`
    : "必须选择一个已存在的环境；Boom 不创建 venv，也不会回退到系统 Python。";
}

async function loadState({replaceSettings = false} = {}) {
  try {
    snapshot = await api("/api/state");
    challenges = snapshot.challenges || [];
    if (!selected || !challenges.some(challenge => challenge.slug === selected))
      selected = challenges[0]?.slug || "";
    $("#path").textContent = snapshot.root;
    const applySettings = !settingsLoaded || replaceSettings;
    if (applySettings) {
      $("#tokens").value = snapshot.settings.tokens;
      $("#repeats").value = snapshot.settings.repeats;
      $("#minutes").value = snapshot.settings.minutes;
      $("#concurrency").value = snapshot.settings.concurrency;
      $("#fmt").value = snapshot.settings.flagFormat || "";
      $("#executionMode").value = snapshot.settings.executionMode || "managed";
      $("#blindReview").checked = snapshot.settings.blindReview !== false;
      settingsLoaded = true;
    }
    syncModelSelects();
    syncEnvironmentSelect();
    if (applySettings) {
      $("#economyModel").value = snapshot.settings.economyModel;
      $("#strongModel").value = snapshot.settings.strongModel;
      const configured = new Set(snapshot.settings.consultModels || []);
      [...$("#consultModels").options].forEach(option => option.selected = configured.has(option.value));
    }
    render();
    void loadSelectedDetail();
  } catch (error) {
    $("#rtTxt").textContent = "error";
    $("#rtDot").className = "dot";
    toast(error.message);
  }
}

async function loadSelectedDetail() {
  const challenge = challengeOf(selected);
  const run = current(challenge);
  if (!challenge || !run) return;
  const requestID = ++detailRequest;
  try {
    const result = await api(`/api/challenges/${encodeURIComponent(challenge.slug)}/runs/${encodeURIComponent(run.id)}`);
    if (requestID !== detailRequest || selected !== challenge.slug) return;
    const latestChallenge = challengeOf(challenge.slug);
    const index = latestChallenge?.runs.findIndex(item => item.id === run.id) ?? -1;
    if (!latestChallenge || index < 0) return;
    const live = latestChallenge.runs[index];
    const keys = new Set();
    const events = [...(result.run.events || []), ...(live.events || [])].filter(event => {
      const key = `${event.at}:${event.type}:${event.status || ""}:${event.tool || ""}:${event.text || ""}`;
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    }).sort((left, right) => left.at - right.at);
    latestChallenge.runs[index] = {
      ...result.run,
      ...(live.stop === "running" || live.stop === "queued" ? {
        stop:live.stop,
        tokens:live.tokens,
        billableTokens:live.billableTokens,
        cost:live.cost,
        lastTool:live.lastTool || result.run.lastTool,
      } : {}),
      events,
    };
    render();
  } catch (error) {
    if (requestID === detailRequest) toast(error.message);
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void loadState(), 250);
}

/**
 * Update one queue row's numbers in place.
 *
 * A live run emits many events per second, and rebuilding `#queue` for each one replaced the node the
 * pointer was pressed on, so `click` (which needs press and release on the same node) never fired and
 * the first click appeared to be ignored. It also destroyed any active text selection.
 */
function patchQueueRow(challenge) {
  const row = $("#queue").querySelector(`.item[data-slug="${cssEscape(challenge.slug)}"]`);
  if (!row) return false;
  const run = last(challenge);
  const [text, color] = label(challenge);
  const status = row.querySelector(".st");
  if (status) {
    status.textContent = text;
    status.className = `st ${color}`;
  }
  const reason = row.querySelector(".why");
  if (reason) reason.textContent = why(challenge);
  const num = row.querySelector(".num");
  if (num && run) num.textContent = `${compactNumber(run.tokens)} · ${mmss(duration(run))}`;
  if (run) {
    const latestTurn = run.turns?.[run.turns.length - 1];
    const percent = Math.min(100, (latestTurn?.tokens ?? run.tokens ?? 0) / tokenLimit() * 100);
    const bar = row.querySelector(".bar i");
    if (bar) {
      bar.style.width = `${percent}%`;
      bar.className = percent >= 100 ? "max" : percent >= 75 ? "hot" : "";
    }
  }
  return true;
}

/** Append only the newly arrived events, so scroll position and selection survive. */
function appendStreamEvents(run, added) {
  const node = $("#stream");
  if (!node || !added.length || !run.events?.length) return false;
  // The first render replaces placeholder text; only append once real lines are present.
  if (!node.querySelector(".t")) return false;
  const start = eventStart(run);
  const stick = atStreamBottom();
  node.insertAdjacentHTML(
    "beforeend",
    `\n${added.map(event => eventLine(event, start)).join("\n")}`,
  );
  if (stick) scrollStreamToBottom();
  return true;
}

function applyRunEvent(update) {
  if (!snapshot || update.type !== "run.event" || !update.slug || !update.event) return false;
  const challenge = challengeOf(update.slug);
  if (!challenge) return false;
  const run = challenge.runs.find(item => item.id === update.runID) ||
    [...challenge.runs].reverse().find(item => item.stop === "running" || item.stop === "queued");
  if (!run) return false;
  run.events ||= [];
  const event = update.event;
  const duplicate = run.events.some(item => item.at === event.at && item.type === event.type &&
    item.status === event.status && item.tool === event.tool && item.text === event.text);
  if (!duplicate) run.events.push(event);
  if (event.tokens != null) run.tokens = event.tokens;
  if (event.billable != null) run.billableTokens = event.billable;
  if (event.cost != null) run.cost = event.cost;
  if (event.tool) run.lastTool = event.tool;

  // Targeted updates only. Fall back to a full render when the row or stream is not on screen yet,
  // which is the one case where rebuilding is both necessary and harmless.
  const patched = patchQueueRow(challenge);
  const streamed = duplicate || challenge.slug !== selected ||
    appendStreamEvents(run, [event]);
  if (!patched || !streamed) render();
  else renderTop();
  return true;
}

const stream = new EventSource("/api/events");
stream.addEventListener("state", event => {
  try {
    const update = JSON.parse(event.data);
    if ((update.type === "run.error" || update.type === "runtime.error") && update.detail)
      toast(update.detail);
    if (update.type === "run.candidate-submitted") {
      scheduleRefresh();
      return;
    }
    // Run deltas already contain everything needed for the live console and counters. Applying them
    // locally avoids downloading and parsing every task's notes, files and event history
    // for each token/tool update. Lifecycle changes still reconcile through one authoritative snapshot.
    if (applyRunEvent(update)) return;
  } catch {
    // Heartbeats and older servers may not carry JSON; the state refresh is still sufficient.
  }
  scheduleRefresh();
});
stream.onerror = () => {
  $("#rtTxt").textContent = "reconnecting";
  $("#rtDot").className = "dot busy";
};

const last = challenge => challenge?.runs?.length
  ? challenge.runs[challenge.runs.length - 1] : null;
const current = challenge => last(challenge);
const challengeOf = slug => challenges.find(challenge => challenge.slug === slug);
const activeCandidate = run => run?.primaryCandidate || run?.candidates?.[0] || "";
const candidateValues = run => [...new Set([
  run?.primaryCandidate,
  ...(run?.candidates || []),
  ...(run?.alternatives || []),
  ...(run?.candidateHistory || []),
  run?.acceptedFlag,
].filter(value => typeof value === "string" && value.trim()))];
const primary = run => candidateValues(run)[0] || "";
const alternatives = run => candidateValues(run).slice(1);
const latestFlagRun = challenge => [...(challenge?.runs || [])]
  .reverse().find(run => candidateValues(run).length > 0);
const displayFlagRun = challenge => {
  const run = current(challenge);
  return candidateValues(run).length ? run : latestFlagRun(challenge);
};
const flagEntries = challenge => {
  const newest = current(challenge);
  const seen = new Set();
  return [...(challenge?.runs || [])].reverse().flatMap(run => candidateValues(run)
    .filter(value => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .map(value => ({value, run, historical:run !== newest})));
};
const confirmedRun = challenge => [...(challenge?.runs || [])].reverse().find(run =>
  run.taskStatus === "archived" || run.confirmedFlag);
const isRunnableChallenge = challenge =>
  !challenge.state &&
  !confirmedRun(challenge) &&
  !activeCandidate(last(challenge)) &&
  !["running","queued"].includes(last(challenge)?.stop);
const runnableChallenges = category => challenges.filter(challenge =>
  (category === undefined || categoryOf(challenge) === category) && isRunnableChallenge(challenge));
const modelOf = () => $("#strongModel")?.value || snapshot?.settings.strongModel || "";
const tokenLimit = () => Number($("#tokens").value) || snapshot?.settings.tokens || 1;

/**
 * The scroller is the tab pane, not the <pre> inside it.
 *
 * A small tolerance is required: fractional device pixels and the trailing line box mean an
 * exactly-equal comparison reads as "not at the bottom" even when the user is visually pinned there.
 */
const STREAM_BOTTOM_SLACK = 24;

function streamPane() {
  return $("#p-stream");
}

function atStreamBottom() {
  const pane = streamPane();
  if (!pane) return true;
  return pane.scrollHeight - pane.scrollTop - pane.clientHeight <= STREAM_BOTTOM_SLACK;
}

function scrollStreamToBottom() {
  const pane = streamPane();
  if (pane) pane.scrollTop = pane.scrollHeight;
}

function formatRegex() {
  const source = $("#fmt").value.trim();
  if (!source) return null;
  try { return new RegExp(`^(?:${source})$`); } catch { return false; }
}

function formatMismatch(run, candidate = primary(run)) {
  const regex = formatRegex();
  return !!(regex && candidate && !regex.test(candidate));
}

function bucket(challenge) {
  if (challenge.state === "removed") return "removed";
  if (challenge.state === "given-up") return "gaveup";
  const run = last(challenge);
  if (!run) return "queued";
  if (run.stop === "running" || run.stop === "queued") return "running";
  if (confirmedRun(challenge)) return "solved";
  if (run.taskStatus === "solved") return "attn";
  if (activeCandidate(run)) return formatMismatch(run, activeCandidate(run)) ? "attn" : "got";
  return "attn";
}

const buckets = [
  ["got","待确认 Flag"],
  ["solved","已确认归档"],
  ["attn","需要处理"],
  ["running","运行中"],
  ["queued","未运行"],
  ["gaveup","已放弃"],
  ["removed","已移出批次"],
];
const categoryOrder = [
  "WEB", "PWN", "REVERSE", "CRYPTO", "MISC", "MOBILE", "FORENSICS",
  "AI", "HARDWARE", "BLOCKCHAIN", "OSINT", "OTHER",
];
const categoryOf = challenge => categoryOrder.includes(challenge.category)
  ? challenge.category : "OTHER";
const bucketRank = Object.fromEntries(buckets.map(([key], index) => [key, index]));

function orderedChallenges(source = challenges.filter(matches)) {
  return categoryOrder.flatMap(category => source
    .filter(challenge => categoryOf(challenge) === category)
    .sort((left, right) => bucketRank[bucket(left)] - bucketRank[bucket(right)] ||
      left.slug.localeCompare(right.slug)));
}

function label(challenge) {
  if (challenge.state === "given-up") return ["已放弃","c-dim"];
  if (challenge.state === "removed") return ["已移出","c-dim"];
  const run = last(challenge);
  if (!run) return ["未运行","c-dim"];
  if (run.stop === "queued") return ["排队中","c-run"];
  if (run.stop === "running") return ["运行中","c-run"];
  if (confirmedRun(challenge)) return ["已归档","c-ok"];
  if (run.taskStatus === "solved") return ["写作中","c-warn"];
  if (activeCandidate(run)) return formatMismatch(run, activeCandidate(run)) ? ["格式不符","c-warn"] : ["待确认","c-warn"];
  return ({
    budget:["超预算","c-warn"], stalled:["卡死","c-warn"],
    timeout:["超时","c-warn"], error:["错误","c-err"],
    empty:["空响应","c-warn"], aborted:["已停止","c-dim"],
    interrupted:["曾中断","c-warn"], completed:["无结果","c-dim"],
  })[run.stop] || [run.stop || "无结果","c-dim"];
}

function why(challenge) {
  const run = last(challenge);
  if (!run) return challenge.state ? "—" : "尚未运行";
  if (run.stop === "queued") return "等待运行槽位";
  if (run.stop === "running") return run.lastTool || "正在分析";
  if (activeCandidate(run) && formatMismatch(run, activeCandidate(run)))
    return `${primary(run)} 不符合你设定的格式`;
  if (run.detail) return run.detail.split("\n")[0];
  if (activeCandidate(run)) return run.verification?.detail || run.reply || "已得到候选 flag";
  return run.reply || "未得到 flag";
}

function matches(challenge) {
  if (!filter) return true;
  const query = filter.toLowerCase();
  const haystack = [
    challenge.slug, challenge.category, challenge.difficulty, challenge.description,
    ...challenge.runs.flatMap(run => [
      ...candidateValues(run), run.detail, run.reply, run.lastTool,
    ]),
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(query);
}

function mmss(seconds) {
  seconds = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(seconds / 60)).padStart(2,"0")}:${String(seconds % 60).padStart(2,"0")}`;
}

function isLive(run) {
  return run?.stop === "running" || run?.stop === "queued";
}

function duration(run) {
  // A live run carries both `startedAt` and a `durationMs` frozen when the snapshot was built, so
  // trusting `durationMs` first froze the displayed time until the next full state fetch.
  if (isLive(run) && run?.startedAt)
    return Math.floor((Date.now() - new Date(run.startedAt).valueOf()) / 1000);
  if (run?.durationMs !== undefined) return Math.floor(run.durationMs / 1000);
  if (run?.startedAt) return Math.floor((Date.now() - new Date(run.startedAt).valueOf()) / 1000);
  return 0;
}

function compactNumber(value) {
  const number = Number(value) || 0;
  return number >= 1000 ? `${(number / 1000).toFixed(number >= 100000 ? 0 : 1)}k` : String(number);
}

function renderQueue() {
  const shown = challenges.filter(matches);
  if (!shown.length) {
    $("#queue").innerHTML = '<div class="empty">没有匹配项</div>';
    return;
  }
  let html = "";
  for (const category of categoryOrder) {
    const list = orderedChallenges(shown).filter(challenge => categoryOf(challenge) === category);
    if (!list.length) continue;
    const runnable = runnableChallenges(category);
    const actions = `${runnable.length
      ? `<button class="grpbtn primary" data-run-category="${esc(category)}"
          title="运行或继续 ${esc(category)} 分类中可运行的 ${runnable.length} 道题">运行本类 · ${runnable.length}</button>` : ""}${
      list.some(challenge => bucket(challenge) === "attn")
      ? `<button class="grpbtn" data-retry-category="${esc(category)}">继续本类</button>` : ""}${
      list.some(challenge => bucket(challenge) === "removed")
        ? `<button class="grpbtn" data-restore-category="${esc(category)}">恢复本类</button>` : ""}`;
    const shut = collapsed.has(category);
    // A filter is an explicit request to see matches, so it overrides a collapsed category.
    const hidden = shut && !filter;
    html += `<div class="grp${hidden ? " shut" : ""}" data-category="${esc(category)}" role="button"
      tabindex="0" aria-expanded="${hidden ? "false" : "true"}"
      title="${hidden ? "展开" : "折叠"} ${esc(category)}"><span class="caret">${
      hidden ? "▸" : "▾"}</span><span>${esc(category)}</span><em>${list.length}</em><i></i>${actions}</div>`;
    if (hidden) continue;
    for (const challenge of list) {
      const key = bucket(challenge);
      const run = last(challenge);
      const allFlags = flagEntries(challenge);
      const flags = allFlags.slice(0, 3);
      const newestUnconfirmed = allFlags.find(isUnconfirmedFlag);
      const [text, color] = label(challenge);
      const latestTurn = run?.turns?.[run.turns.length - 1];
      const percent = run ? Math.min(100, (latestTurn?.tokens ?? run.tokens ?? 0) / tokenLimit() * 100) : 0;
      const barClass = percent >= 100 ? "max" : percent >= 75 ? "hot" : "";
      html += `<div class="item ${challenge.slug === selected ? "sel" : ""} ${
        ["solved","gaveup","removed"].includes(key) ? "done" : ""}" data-slug="${esc(challenge.slug)}" role="button" tabindex="0">
        <span class="r1">
          <span class="slug" title="${esc(challenge.slug)}">${esc(challenge.slug)}</span>
          ${run?.turns?.length ? `<span class="runs">${run.turns.length} 轮</span>` :
            challenge.runs.length > 1 ? `<span class="runs">${challenge.runs.length} 个旧任务</span>` : ""}
          ${run?.consultation ? '<span class="runs" title="本次运行使用了多模型会诊">⚖</span>' : ""}
          <span class="st ${color}">${text}</span>
          <button class="kebab" type="button" data-menu="${esc(challenge.slug)}" title="更多操作">⋯</button>
        </span>
        <span class="r2"><span class="why">${esc(why(challenge))}</span></span>
        ${flags.length ? `<span class="flag-list">${flags.map(entry =>
          `<button class="flag ${entry === newestUnconfirmed ? "" : "muted"}" type="button"
            data-copy-flag="${esc(entry.value)}" title="点击复制${entry.historical ? "历史" : ""} flag">${
              entry.historical ? '<span class="flag-source">历史 · </span>' : ""}${esc(entry.value)}</button>`
        ).join("")}</span>` : ""}
        <span class="r3"><span class="mtag" title="Strong 模型（在设置中统一配置）">${
          esc(shortModel(modelOf()))}</span>${
          run ? `<span class="num">${compactNumber(run.tokens)} · ${mmss(duration(run))}</span>` : ""}</span>
        ${run ? `<span class="bar"><i class="${barClass}" style="width:${percent}%"></i></span>` : ""}
      </div>`;
    }
  }
  $("#queue").innerHTML = html;
}

function verificationText(run) {
  if (run?.platformSubmission && !(run.platformSubmission.verdict === "pending" && run.acceptedFlag)) {
    const verdict = {accepted:"已接受", rejected:"已拒绝", pending:"等待人工判定"}[
      run.platformSubmission.verdict] || run.platformSubmission.verdict;
    return `${run.platformSubmission.adapter} · ${verdict} · ${run.platformSubmission.detail}`;
  }
  if (!run?.verification) return "等待人工判定";
  const labels = {
    remote:"远程服务验证", "local-checker":"本地 checker 验证",
    "offline-derivation":"离线推导", unverified:"未验证",
  };
  return `${labels[run.verification.level] || run.verification.level} · ${run.verification.detail}`;
}

function eventLine(event, start) {
  const at = `<span class="t">${mmss((event.at - start) / 1000)}</span> `;
  if (event.type === "tool")
    return `${at}<span class="${event.status === "error" ? "bad" : "tool"}">${esc(event.tool)}</span> ${
      esc(event.text || event.status || "")}`;
  if (event.type === "usage")
    return `${at}<span class="tool">usage</span> ${compactNumber(event.tokens)} tokens · $${Number(event.cost || 0).toFixed(4)}`;
  if (event.type === "text") return `${at}<span class="say">${esc(event.text || "")}</span>`;
  const bad = ["error","budget","stalled","timeout","aborted"].includes(event.status);
  return `${at}<span class="${bad ? "bad" : event.status === "completed" ? "good" : "tool"}">${
    esc(event.status || event.type)}</span> ${esc(event.text || "")}`;
}

function eventStart(run) {
  return run.startedAt ? new Date(run.startedAt).valueOf() : run.events[0].at;
}

function renderEvents(run) {
  if (!run?.events?.length) return "该历史运行没有事件日志；结果、NOTES 和文件仍可复核。";
  const start = eventStart(run);
  return run.events.slice(-600).map(event => eventLine(event, start)).join("\n");
}

function renderFileTree(files) {
  const root = {path:"", children:new Map(), file:null};
  for (const file of files || []) {
    const parts = String(file.path || "").split("/").filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const childPath = node.path ? node.path + "/" + name : name;
      if (!node.children.has(name))
        node.children.set(name, {path:childPath, children:new Map(), file:null});
      node = node.children.get(name);
    }
    node.file = file;
  }
  const ordered = node => [...node.children.entries()].sort(([leftName, left], [rightName, right]) => {
    const leftDirectory = left.file?.directory || left.children.size > 0;
    const rightDirectory = right.file?.directory || right.children.size > 0;
    return Number(rightDirectory) - Number(leftDirectory) || leftName.localeCompare(rightName);
  });
  const renderNode = ([name, node]) => {
    const directory = node.file?.directory || node.children.size > 0;
    if (directory) return "<details class=\"fdir\"><summary><span class=\"fdir-name\">" + esc(name) +
      "/</span><span class=\"sz\">目录</span><button class=\"btn tiny\" type=\"button\" data-open-file=\"" +
      esc(node.path) + "\">打开</button></summary><div class=\"fchildren\">" +
      ordered(node).map(renderNode).join("") + "</div></details>";
    const file = node.file || {size:0};
    return "<div class=\"frow\"><code>" + esc(name) + "</code><span class=\"sz\">" +
      compactNumber(file.size) + " B</span><button class=\"btn tiny\" type=\"button\" data-open-file=\"" +
      esc(node.path) + "\">打开</button></div>";
  };
  return ordered(root).map(renderNode).join("");
}

function flagHistoryStatus(entry) {
  if (entry.run.acceptedFlag === entry.value || entry.run.confirmedFlag === entry.value)
    return ["已确认", "ok"];
  if (entry.run.rejectedFlags?.includes(entry.value))
    return ["已否定", "rejected"];
  return ["待确认", ""];
}

function isUnconfirmedFlag(entry) {
  return entry.run.acceptedFlag !== entry.value &&
    entry.run.confirmedFlag !== entry.value &&
    !entry.run.rejectedFlags?.includes(entry.value);
}

function renderFlagHistory(challenge) {
  const entries = flagEntries(challenge);
  if (!entries.length) return '<div class="empty">尚无 flag 历史</div>';
  return entries.map((entry, index) => {
    const [status, style] = flagHistoryStatus(entry);
    // Any candidate of any run of this challenge can be judged here, including one from an older run
    // whose verdict was never recorded.
    const actions = isUnconfirmedFlag(entry)
      ? "<span class=\"flag-history-actions\"><button type=\"button\" class=\"btn tiny act\" " +
        "data-history-correct=\"" + index + "\">确认正确</button>" +
        "<button type=\"button\" class=\"btn tiny\" data-history-wrong=\"" + index + "\">否定</button></span>"
      : "";
    return "<div class=\"flag-history-row\"><div class=\"flag-history-main\"><button type=\"button\" " +
      "class=\"flag-history-value\" data-copy-history-flag=\"" + esc(entry.value) + "\" title=\"点击复制 flag\">" +
      esc(entry.value) + "</button><span class=\"flag-history-meta\">" +
      (entry.historical ? "历史运行" : "当前运行") + " · " + esc(entry.run.id) +
      "</span></div>" + actions + "<span class=\"flag-history-status " + style + "\">" + status + "</span></div>";
  }).join("");
}

function renderDetail() {
  const challenge = challengeOf(selected);
  if (!challenge) {
    $("#stopOne").classList.add("hide");
    $("#dSlug").textContent = "—";
    $("#dSlug").title = "";
    $("#stream").textContent = "没有题目";
    $("#writeup").innerHTML = "";
    $("#flagHistory").innerHTML = "";
    return;
  }
  const run = current(challenge);
  const live = isLive(run);
  $("#stopOne").classList.toggle("hide", !live);
  $("#switchEnvironment").disabled = !run || run.stop === "running" || run.stop === "queued";
  const dTitle = `${categoryOf(challenge)} / ${challenge.slug}`;
  $("#dSlug").textContent = dTitle;
  $("#dSlug").title = dTitle;
  $("#dMeta").textContent = `${challenge.files.length} 个附件${
    challenge.difficulty ? ` · ${challenge.difficulty}` : ""} · ${
    $("#fmt").value.trim() ? `格式 ${$("#fmt").value.trim()}` : "格式由模型判断"}`;
  const candidateRun = displayFlagRun(challenge);
  const flag = primary(candidateRun);
  const mismatch = flag && formatMismatch(candidateRun, flag);
  const archived = candidateRun?.taskStatus === "archived" || !!candidateRun?.confirmedFlag;
  const accepted = candidateRun?.taskStatus === "solved" || !!candidateRun?.acceptedFlag || archived;
  $("#verdict").classList.toggle("candidate", !!flag && !mismatch && !accepted);
  $("#verdict").classList.toggle("accepted", !!flag && !mismatch && accepted);
  $("#vFlag").className = `vflag${flag ? mismatch ? " miss" : "" : " none"}`;
  $("#vFlag").textContent = flag || (run ? "本次运行未得到 flag" : "尚未运行");
  $("#copyFlag").classList.toggle("hide", !flag);
  $("#flagActions").classList.toggle("hide", !flag || live);
  $("#flagWrong").classList.toggle("hide", !flag || accepted || live);
  $("#flagCorrect").classList.toggle("hide", !flag || accepted || live);
  $("#flagWriteup").classList.toggle("hide", !flag || !accepted || archived || live);
  $("#flagWriteup").disabled = !run || run.stop === "running" || run.stop === "queued";
  let source = "";
  if (flag) {
    source = candidateRun.candidateSource === "submission" ? "由 Boom 提交槽接收" :
      candidateRun.candidateSource === "regex" ? "按设定正则提取" : "由模型判定";
    source = `<span class="src">${esc(source)} · ${esc(verificationText(candidateRun))}</span>`;
    if (archived) source += '<br><span class="src" style="color:var(--green)">✓ Writeup 已完成，任务已归档</span>';
    else if (accepted) source += '<br><span class="src" style="color:var(--amber)">✓ Flag 已确认，主流程结束；需要时点击「生成 Writeup」</span>';
    if (candidateRun.rejectedFlags?.includes(flag))
      source += '<br><span class="src" style="color:var(--amber)">已标记为错误，仍会保留；如果判断有误可重新确认。</span>';
    if (alternatives(candidateRun).length)
      source += `<br>本任务历史候选：${alternatives(candidateRun).map(candidate =>
        `<button class="alt" data-alt="${esc(candidate)}">${esc(candidate)}</button>`).join("")}`;
  }
  if (flag && candidateRun !== run)
    source += '<br><span class="src">历史任务中的候选；当前运行没有新 flag。</span>';
  $("#vWhy").innerHTML = source;
  $("#vWhy").querySelectorAll("[data-alt]").forEach(button =>
    button.onclick = () => copy(button.dataset.alt, "已复制备选串"));

  let alert = "";
  if (mismatch) alert += `<div class="alert warn"><div><b>候选 flag 不符合当前格式</b>
    <span class="m">${esc(flag)}</span> 不匹配 <span class="m">${esc($("#fmt").value)}</span></div>
    <button class="btn tiny act" id="fixFmt">按此串放宽格式</button></div>`;
  const messages = {
    error:["err","运行时错误"], stalled:["warn","重复调用保护触发"],
    budget:["warn","token 预算耗尽"], timeout:["warn","运行超时"],
    empty:["warn","模型没有产生文本或工具调用"], aborted:["warn","运行已由用户停止"],
    interrupted:["warn","该历史工作区没有 result.json，可能曾异常中断"],
  };
  if (run && messages[run.stop]) {
    const [style,title] = messages[run.stop];
    alert += `<div class="alert ${style}"><div><b>${title}</b><span class="m">${
      esc(run.detail || "")}</span></div>${
      run.stop === "budget" ? '<button class="btn tiny act" id="raiseBudget">提高上限并继续</button>' : ""
    }</div>`;
  }
  $("#alerts").innerHTML = alert;
  if ($("#fixFmt")) $("#fixFmt").onclick = () => {
    const match = /^([A-Za-z0-9_.-]{1,32})\{.*\}$/s.exec(flag);
    $("#fmt").value = match ? `${match[1]}\\{[^}]*\\}` : "";
    render();
  };
  if ($("#raiseBudget")) $("#raiseBudget").onclick = () => {
    $("#tokens").value = String(Number($("#tokens").value) * 2);
    void saveSettings({close:false}).then(saved => {
      if (saved) void rerun();
    });
  };

  // Preserve the reading position across a full redraw: follow the tail only when already there.
  const stickStream = atStreamBottom();
  $("#stream").innerHTML = renderEvents(run);
  if (stickStream) scrollStreamToBottom();
  if (run?.consultation) {
    const consultation = run.consultation;
    $("#consultation").innerHTML = [
      `<div class="cmeta">多模型会诊 · ${esc(consultation.trigger)} · ${compactNumber(consultation.tokens)} tokens</div>`,
      ...(consultation.plans || []).map((plan, index) =>
        `<section><h3>专家 ${String.fromCharCode(65 + index)} · ${esc(plan.model)}</h3><pre>${esc(plan.text)}</pre></section>`),
      consultation.merged
        ? `<section class="merged"><h3>综合计划 · ${esc(consultation.merged.model)}</h3><pre>${esc(consultation.merged.text)}</pre></section>`
        : "",
    ].join("");
  } else {
    $("#consultation").innerHTML = '<div class="empty">该任务还没有会诊记录</div>';
  }
  // Read-only rendering. Editing these is deliberately not offered: a running agent writes NOTES.md
  // concurrently, so a user edit and the agent's next write would overwrite each other.
  const notesText = run?.notes || "";
  $("#notes").innerHTML = notesText.trim()
    ? renderMarkdown(notesText)
    : '<div class="empty">（尚无 NOTES.md 内容）</div>';
  const writeupText = flag ? candidateRun?.writeup || "" : "";
  $("#writeup").innerHTML = writeupText.trim() ? renderMarkdown(writeupText) : "";
  $("#flagHistory").innerHTML = renderFlagHistory(challenge);
  $("#flagHistory").querySelectorAll("[data-copy-history-flag]").forEach(button =>
    button.onclick = () => copy(button.dataset.copyHistoryFlag, "flag 已复制"));
  const historyEntries = flagEntries(challenge);
  $("#flagHistory").querySelectorAll("[data-history-correct]").forEach(button =>
    button.onclick = () => {
      const entry = historyEntries[Number(button.dataset.historyCorrect)];
      if (entry) void reviewFlag(true, {run:entry.run, flag:entry.value});
    });
  $("#flagHistory").querySelectorAll("[data-history-wrong]").forEach(button =>
    button.onclick = () => {
      const entry = historyEntries[Number(button.dataset.historyWrong)];
      if (entry) void reviewFlag(false, {run:entry.run, flag:entry.value});
    });
  $("#files").innerHTML = run?.files?.length ? renderFileTree(run.files)
    : '<div class="empty">尚无运行文件</div>';
  $("#files").querySelectorAll("[data-open-file]").forEach(button =>
    button.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      void openPath("file", challenge.slug, run?.id, button.dataset.openFile);
    });
  const rows = run ? [
    ["task id",run.id], ["任务状态",run.taskStatus || "旧运行"], ["当前模型",run.model],
    ["Python 环境",run.environment ? `${run.environment.displayName} · ${run.environment.kind} · Python ${run.environment.pythonVersion}` : "未绑定"],
    ["执行模式",run.environment?.executionMode || "—"],
    ["环境指纹",run.environment?.fingerprint || "—"],
    ["轮次",String(run.turns?.length || 1)], ["最近 stop",run.stop],
    ["tokens",String(run.tokens || 0)], ["billable",String(run.billableTokens || 0)],
    ["费用",`$${Number(run.cost || 0).toFixed(4)}`], ["耗时",mmss(duration(run))],
    ["最后调用",run.lastTool || "—"], ["flag",flag || "—"],
    ["来源",candidateRun?.candidateSource || "—"], ["判定",flag ? verificationText(candidateRun) : "—"],
    ["否定的 flag",(run.rejectedFlags || []).join(", ") || "—"],
    ...(run.turns || []).map((turn, index) => [
      `轮次 ${index + 1}`,
      `${shortModel(turn.model)} · ${turn.stop} · ${compactNumber(turn.tokens)} tokens${
        turn.prompt ? ` · 提示：${turn.prompt}` : ""}`,
    ]),
  ] : [["—","尚未运行"]];
  $("#meta").innerHTML = rows.map(([key,value]) =>
    `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join("");
}

async function switchTaskEnvironment() {
  const challenge = challengeOf(selected);
  const run = current(challenge);
  const profileId = $("#pythonEnvironment").value || snapshot?.environments?.defaultProfileId;
  if (!challenge || !run) return;
  if (!profileId) return toast("先在运行设置中选择 Python 环境", true);
  try {
    await api("/api/environments/task", {
      method: "PATCH",
      body: JSON.stringify({
        slug: challenge.slug,
        runID: run.id,
        profileId,
        executionMode: $("#executionMode").value,
      }),
    });
    await loadState();
    toast("任务环境已切换；下次继续将创建使用新环境的新会话");
  } catch (error) {
    toast(error.message, true);
  }
}

function renderTop() {
  const flagRows = challenges.map(challenge => [challenge, latestFlagRun(challenge)])
    .filter(([,run]) => run && primary(run) && run.taskStatus !== "archived" && !run.confirmedFlag);
  $("#pendN").textContent = flagRows.length;
  $("#pending").classList.toggle("zero", flagRows.length === 0);
  $("#found").textContent = `${challenges.length} 题`;
  let tokens = 0, cost = 0;
  for (const challenge of challenges) for (const run of challenge.runs) {
    tokens += Number(run.tokens) || 0;
    cost += Number(run.cost) || 0;
  }
  $("#tokTotal").textContent = compactNumber(tokens);
  $("#costTotal").textContent = cost.toFixed(2);
  const runtime = snapshot?.runtime || {status:"error",active:0,queued:0};
  const busy = runtime.active > 0 || runtime.queued > 0;
  $("#rtDot").className = `dot${busy || runtime.status === "starting" ? " busy" : ""}`;
  $("#rtTxt").textContent = runtime.error ? "error" : busy ? "running" : runtime.status;
  $("#run").classList.toggle("hide", busy);
  $("#halt").classList.toggle("hide", !busy);
  $("#concStatus").textContent = `${runtime.active || 0}/${$("#concurrency").value || 1}`;
  $("#settingsSummary").textContent = `E ${shortModel($("#economyModel").value)} / S ${shortModel($("#strongModel").value)} · ${
    compactNumber($("#tokens").value)} tokens/轮 · ${$("#minutes").value} min/轮`;
}

function render() {
  if (!snapshot) return;
  renderQueue();
  renderDetail();
  renderTop();
}

function readSettings() {
  const flagFormat = $("#fmt").value.trim();
  if (flagFormat) {
    try { new RegExp(flagFormat); } catch { throw new Error("flag 格式不是有效正则"); }
  }
  const settings = {
    economyModel: $("#economyModel").value,
    strongModel: $("#strongModel").value,
    tokens: Number($("#tokens").value),
    repeats: Number($("#repeats").value),
    minutes: Number($("#minutes").value),
    concurrency: Number($("#concurrency").value),
    flagFormat,
    executionMode: $("#executionMode").value,
    consultModels: [...$("#consultModels").selectedOptions].map(option => option.value),
    blindReview: $("#blindReview").checked,
  };
  if (!settings.economyModel.includes("/") || !settings.strongModel.includes("/"))
    throw new Error("Economy 与 Strong 模型都必须是 provider/model");
  if (settings.consultModels.length !== 0 && (settings.consultModels.length < 2 || settings.consultModels.length > 4))
    throw new Error("多模型会诊池必须留空或选择 2–4 个模型");
  if (!(settings.tokens > 0 && settings.repeats >= 2 && settings.minutes > 0 && settings.concurrency > 0))
    throw new Error("运行参数必须为正数，repeats 至少为 2");
  return settings;
}

async function saveSettings({close = true} = {}) {
  try {
    const settings = readSettings();
    const result = await api("/api/settings", {
      method:"PATCH",
      body:JSON.stringify(settings),
    });
    snapshot.settings = result.settings;
    const profileId = $("#pythonEnvironment").value;
    if (!profileId) throw new Error("请选择默认 Python 环境");
    const environment = await api("/api/environments/default", {
      method:"PATCH",
      body:JSON.stringify({profileId}),
    });
    snapshot.environments = environment.store;
    if (close) $("#settingsDlg").close();
    render();
    toast("运行设置已保存");
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}

function providerURL(id, suffix = "") {
  return `/api/providers/${encodeURIComponent(id)}${suffix}`;
}

function renderProviderList() {
  const query = $("#providerFind").value.trim().toLowerCase();
  const visible = providerCatalog.filter(provider =>
    !query || `${provider.name} ${provider.id}`.toLowerCase().includes(query));
  $("#providerList").innerHTML = visible.length ? visible.map(provider =>
    `<button class="provider-item ${provider.id === providerSelected ? "on" : ""}"
      data-provider="${esc(provider.id)}">
      <span class="pname"><i class="pstatus ${
        provider.disabled ? "off" : provider.connected ? "on" : ""}"></i>
        <span>${esc(provider.name)}</span>${provider.custom ? '<span class="badge">自定义</span>' : ""}</span>
      <span class="pid">${esc(provider.id)}</span>
      <span class="pmeta">${provider.disabled ? "已禁用" :
        provider.connected ? "已连接" : provider.configured ? "已配置" : "未连接"} · ${
        provider.visibleModelCount}/${provider.modelCount} 模型可见</span>
    </button>`).join("") : '<div class="empty">没有匹配的 Provider</div>';
}

function renderProviderModels() {
  const models = providerDraft?.models || [];
  $("#providerModels").innerHTML = models.length ? models.map((model, index) => {
    const custom = model.source === "custom";
    const promptOptions = [
      `<option value="">不使用</option>`,
      ...armorPromptCatalog.map(prompt =>
        `<option value="${esc(prompt.id)}" ${prompt.id === model.armorPrompt ? "selected" : ""}>${
          esc(prompt.name)}</option>`),
    ].join("");
    return `<div class="model-row" data-model-index="${index}">
      <input type="checkbox" data-model-enabled ${model.enabled ? "checked" : ""}
        title="是否在 Boom 模型选择器中显示">
      <input type="text" data-model-id value="${esc(model.id)}" ${custom ? "" : "disabled"}
        spellcheck="false">
      <input type="text" data-model-name value="${esc(model.name)}">
      <input type="number" data-model-context value="300000" disabled title="Boom 统一使用 300k 上下文窗口">
      <input type="number" data-model-output value="${Number(model.output) || 16384}"
        min="1">
      <input type="number" data-model-price-input value="${model.pricing?.input ?? ""}"
        min="0" step="0.000001" placeholder="未知">
      <input type="number" data-model-price-output value="${model.pricing?.output ?? ""}"
        min="0" step="0.000001" placeholder="未知">
      <select data-model-armor title="置于 Agent 系统提示词之前">${promptOptions}</select>
      <span class="model-caps">
        <label title="推理模型"><input type="checkbox" data-model-reasoning ${
          model.reasoning ? "checked" : ""}>推理</label>
        <label title="支持图片附件"><input type="checkbox" data-model-attachment ${
          model.attachment ? "checked" : ""}>图片</label>
      </span>
      <button class="remove-model ${custom ? "" : "hide"}" data-remove-model="${index}"
        title="删除自定义模型">×</button>
    </div>`;
  }).join("") : '<div class="empty">还没有模型，请点击“＋ 模型”添加。</div>';
}

function renderProviderEditor() {
  const draft = providerDraft;
  $("#providerEmpty").classList.toggle("hide", !!draft);
  $("#providerForm").classList.toggle("hide", !draft);
  if (!draft) return;
  $("#providerTitle").textContent = draft.name || "新 Provider";
  $("#providerTitleID").textContent = draft.id || "尚未保存";
  $("#providerKind").textContent = draft.custom ? "自定义" : "Boom 内置";
  $("#providerConnection").textContent = draft.disabled ? "已禁用" :
    draft.connected ? "已连接" : "未连接";
  $("#providerConnection").className = `badge ${
    draft.connected && !draft.disabled ? "good" : draft.disabled ? "bad" : ""}`;
  $("#providerStatusDot").className = `pstatus ${
    draft.disabled ? "off" : draft.connected ? "on" : ""}`;
  $("#providerID").value = draft.id || "";
  $("#providerID").disabled = !providerNew;
  $("#providerName").value = draft.name || "";
  $("#providerDriver").value = draft.driver || "openai-compatible";
  $("#providerDriver").disabled = !draft.custom;
  $("#providerNpm").value = draft.npm || "";
  $("#providerNpm").disabled = !draft.custom;
  $("#providerApi").value = draft.api || "";
  $("#providerBaseURL").value = draft.baseURL || "";
  $("#providerApiKey").value = "";
  $("#providerCredentialRemove").disabled = providerNew || !draft.connected;
  const oauthMethods = (draft.authMethods || []).filter(method => method.type === "oauth");
  $("#providerAuthMethods").innerHTML = oauthMethods.length
    ? `<span>OAuth 登录</span>${oauthMethods.map(method =>
        `<button class="btn tiny" data-provider-oauth="${method.index}" type="button">${
          esc(method.label)}</button>`).join("")}`
    : '<span>该 Provider 没有可用的 OAuth 登录方式，可使用 API Key 或本地配置。</span>';
  $("#providerDelete").textContent = draft.custom ? "删除 Provider" :
    draft.disabled ? "保持禁用" : "禁用 Provider";
  $("#providerDelete").disabled = providerNew || draft.disabled;
  renderProviderModels();
}

async function selectProvider(id) {
  providerSelected = id;
  providerNew = false;
  renderProviderList();
  try {
    const result = await api(providerURL(id));
    if (providerSelected !== id || providerNew) return;
    providerDraft = structuredClone(result.provider);
    renderProviderEditor();
  } catch (error) {
    if (providerSelected !== id || providerNew) return;
    providerDraft = null;
    renderProviderEditor();
    toast(error.message);
  }
}

async function loadProviders({select = providerSelected} = {}) {
  try {
    const result = await api("/api/providers");
    providerCatalog = result.providers || [];
    renderProviderList();
    const next = providerCatalog.some(provider => provider.id === select)
      ? select : providerCatalog.find(provider => provider.configured)?.id ||
        providerCatalog[0]?.id;
    if (next) await selectProvider(next);
  } catch (error) {
    toast(error.message);
  }
}

async function loadArmorPrompts() {
  const result = await api("/api/armor-prompts");
  armorPromptCatalog = result.prompts || [];
  return armorPromptCatalog;
}

function platformURL(id, suffix = "") {
  return `/api/platforms/${encodeURIComponent(id)}${suffix}`;
}

function renderPlatformSelect() {
  const current = platformSelected || $("#platformSelect").value;
  $("#platformSelect").innerHTML = [
    '<option value="">— 选择已有适配器 —</option>',
    ...platformCatalog.map(platform => `<option value="${esc(platform.id)}">${
      platform.status === "ready" ? "●" : platform.status === "draft" ? "◐" : "×"} ${
      esc(platform.name || platform.id)} · ${esc(platform.id)}</option>`),
  ].join("");
  $("#platformSelect").value = platformCatalog.some(platform => platform.id === current) ? current : "";
}

function renderPlatformStatus(platform, credential) {
  if (!platform) {
    $("#platformStatus").textContent = "尚未选择适配器";
    return;
  }
  const capabilities = [
    platform.listChallenges === false ? "无远端清单" : "可选择同步",
    platform.acquireChallenges === false ? "无题目下载" : "题目下载",
    platform.submitFlag ? "flag 提交" : "无自动提交",
  ].join(" · ");
  const auth = credential || platform.credential;
  const credentialText = auth
    ? `${auth.configured ? "凭证已配置" : "凭证未配置"}：${auth.env}`
    : "接口未声明凭证";
  $("#platformStatus").innerHTML = `<span class="badge ${
    platform.status === "ready" ? "good" : "bad"}">${esc(platform.status)}</span>` +
    `<span>${esc(capabilities)}</span><span>${esc(credentialText)}</span>` +
    (platform.error ? `<span style="color:var(--red)">${esc(platform.error)}</span>` : "");
}

function resetPlatformCatalog() {
  platformRemoteCatalog = {items:[], page:0, pageSize:50, total:0, categories:[], difficulties:[]};
  platformRemoteSelection = {all:false, ids:new Set()};
  platformCatalogLoaded = false;
  if ($("#platformChallengeSearch")) $("#platformChallengeSearch").value = "";
  if ($("#platformChallengeCategory")) $("#platformChallengeCategory").innerHTML = '<option value="">全部分类</option>';
  if ($("#platformChallengeDifficulty")) $("#platformChallengeDifficulty").innerHTML = '<option value="">全部难度</option>';
  renderPlatformCatalog();
}

async function selectPlatform(id) {
  platformSelected = id;
  resetPlatformCatalog();
  renderPlatformSelect();
  const summary = platformCatalog.find(platform => platform.id === id);
  if (!id) {
    $("#platformManifest").value = "";
    $("#platformWarnings").textContent = "";
    renderPlatformStatus(null);
    return;
  }
  try {
    const result = await api(platformURL(id));
    if (platformSelected !== id) return;
    $("#platformManifest").value = JSON.stringify(result.manifest, null, 2);
    $("#platformID").value = result.manifest.id;
    $("#platformName").value = result.manifest.name || "";
    $("#platformWarnings").textContent = "";
    renderPlatformStatus(summary || {
      status:result.manifest.status,
      listChallenges:true,
      acquireChallenges:true,
      submitFlag:!!result.manifest.operations?.submitFlag,
    }, result.credential);
  } catch (error) {
    $("#platformManifest").value = "";
    renderPlatformStatus(summary || {status:"invalid", error:error.message});
    toast(error.message);
  }
}

async function loadPlatforms({select = platformSelected} = {}) {
  const result = await api("/api/platforms");
  platformCatalog = result.platforms || [];
  const next = platformCatalog.some(platform => platform.id === select)
    ? select : platformCatalog[0]?.id || "";
  platformSelected = next;
  renderPlatformSelect();
  await selectPlatform(next);
}

async function openPlatforms() {
  $("#settingsDlg").close();
  $("#platformsDlg").showModal();
  try {
    await loadPlatforms({});
  } catch (error) {
    toast(error.message);
  }
}

async function adaptPlatform() {
  const id = $("#platformID").value.trim();
  const document = $("#platformDocument").value.trim();
  if (!id || !document) return toast("请填写 Adapter ID 和接口文档地址");
  try {
    $("#platformAdapt").disabled = true;
    const result = await api("/api/platforms/adapt", {
      method:"POST",
      body:JSON.stringify({
        id,
        document,
        name:$("#platformName").value.trim() || undefined,
        baseURL:$("#platformBaseURL").value.trim() || undefined,
        force:$("#platformForce").checked,
      }),
    });
    platformSelected = result.manifest.id;
    await loadPlatforms({select:platformSelected});
    $("#platformWarnings").textContent = (result.warnings || []).length
      ? result.warnings.map(warning => `• ${warning}`).join("\n")
      : "自动推断没有留下警告；仍建议在首次同步前检查清单。";
    toast(`适配器 ${result.manifest.id} 已生成：${result.manifest.status}`);
  } catch (error) {
    toast(error.message);
  } finally {
    $("#platformAdapt").disabled = false;
  }
}

async function savePlatformManifest() {
  if (!platformSelected) return toast("请先选择或生成一个适配器");
  try {
    const manifest = JSON.parse($("#platformManifest").value);
    $("#platformSave").disabled = true;
    const result = await api(platformURL(platformSelected), {
      method:"PUT",
      body:JSON.stringify({manifest}),
    });
    platformSelected = result.manifest.id;
    await loadPlatforms({select:platformSelected});
    toast(`适配器 ${platformSelected} 已保存`);
  } catch (error) {
    toast(error instanceof SyntaxError ? `JSON 格式错误：${error.message}` : error.message);
  } finally {
    $("#platformSave").disabled = false;
  }
}

function platformVariables() {
  const variables = {};
  for (const [index, raw] of $("#platformVariables").value.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`同步变量第 ${index + 1} 行必须是 name=value`);
    variables[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return variables;
}

function platformCatalogQuery({page = platformRemoteCatalog.page || 1} = {}) {
  return {
    page,
    pageSize:platformRemoteCatalog.pageSize || 50,
    search:$("#platformChallengeSearch").value.trim() || undefined,
    category:$("#platformChallengeCategory").value || undefined,
    difficulty:$("#platformChallengeDifficulty").value || undefined,
  };
}

function platformSelectionCount() {
  return platformRemoteSelection.all
    ? Math.max(0, platformRemoteCatalog.total - platformRemoteSelection.ids.size)
    : platformRemoteSelection.ids.size;
}

function platformItemSelected(id) {
  return platformRemoteSelection.all
    ? !platformRemoteSelection.ids.has(id)
    : platformRemoteSelection.ids.has(id);
}

function renderPlatformFacet(select, values, fallback) {
  const current = select.value;
  select.innerHTML = [
    `<option value="">${esc(fallback)}</option>`,
    ...values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`),
  ].join("");
  select.value = values.includes(current) ? current : "";
}

function renderPlatformCatalog() {
  const list = $("#platformChallengeList");
  if (!list) return;
  const rows = platformRemoteCatalog.items || [];
  list.innerHTML = rows.length ? rows.map(item => {
    const metadata = [item.group?.name, item.category, item.difficulty, item.solved ? "已解出" : ""]
      .filter(Boolean).join(" · ");
    return `<label class="platform-challenge" data-platform-challenge="${esc(item.id)}">
      <input type="checkbox" ${platformItemSelected(item.id) ? "checked" : ""}>
      <span class="platform-challenge-main">
        <span class="platform-challenge-title">${esc(item.title)}</span>
        <span class="platform-challenge-meta">${esc(metadata || item.challengeID)}</span>
      </span>
      <span class="platform-challenge-points">${item.points == null ? "" : `${esc(item.points)} pts`}</span>
    </label>`;
  }).join("") : `<div class="platform-catalog-empty">${
    platformCatalogLoaded ? "当前筛选条件下没有题目" : "点击“获取题目清单”后选择要同步的题目"
  }</div>`;
  const pages = platformRemoteCatalog.total
    ? Math.ceil(platformRemoteCatalog.total / platformRemoteCatalog.pageSize) : 0;
  $("#platformCatalogPage").textContent = `第 ${platformRemoteCatalog.page || 0} / ${pages} 页`;
  $("#platformCatalogPrev").disabled = !platformCatalogLoaded || platformRemoteCatalog.page <= 1;
  $("#platformCatalogNext").disabled = !platformCatalogLoaded || platformRemoteCatalog.page >= pages;
  $("#platformSelectAll").checked = platformRemoteSelection.all;
  const selectedCount = platformSelectionCount();
  $("#platformSelectionStatus").textContent = platformCatalogLoaded
    ? `共 ${platformRemoteCatalog.total} 道，已选择 ${selectedCount} 道`
    : "尚未获取远端题目";
  $("#platformSync").disabled = !platformCatalogLoaded || selectedCount === 0;
}

async function loadPlatformCatalog({page = 1, resetSelection = false} = {}) {
  if (!platformSelected) return toast("请先选择或生成一个适配器");
  try {
    $("#platformCatalogLoad").disabled = true;
    if (resetSelection) platformRemoteSelection = {all:false, ids:new Set()};
    const result = await api(platformURL(platformSelected, "/catalog"), {
      method:"POST",
      body:JSON.stringify({variables:platformVariables(), query:platformCatalogQuery({page})}),
    });
    platformRemoteCatalog = {
      items:result.items || [],
      page:result.page || page,
      pageSize:result.pageSize || 50,
      total:result.total || 0,
      categories:result.categories || platformRemoteCatalog.categories || [],
      difficulties:result.difficulties || platformRemoteCatalog.difficulties || [],
    };
    platformCatalogLoaded = true;
    renderPlatformFacet($("#platformChallengeCategory"), platformRemoteCatalog.categories, "全部分类");
    renderPlatformFacet($("#platformChallengeDifficulty"), platformRemoteCatalog.difficulties, "全部难度");
    renderPlatformCatalog();
  } catch (error) {
    toast(error.message);
  } finally {
    $("#platformCatalogLoad").disabled = false;
  }
}

async function syncPlatform() {
  if (!platformSelected) return toast("请先选择一个适配器");
  const count = platformSelectionCount();
  if (!platformCatalogLoaded || count === 0) return toast("请先获取清单并选择至少一道题目");
  try {
    $("#platformSync").disabled = true;
    const query = platformCatalogQuery({page:1});
    delete query.page;
    delete query.pageSize;
    const selection = platformRemoteSelection.all
      ? {all:true, exclude:[...platformRemoteSelection.ids], query}
      : {ids:[...platformRemoteSelection.ids]};
    const result = await api(platformURL(platformSelected, "/sync"), {
      method:"POST",
      body:JSON.stringify({variables:platformVariables(), selection}),
    });
    await loadState();
    await loadPlatforms({select:platformSelected});
    toast(`已同步 ${result.challenges.length} 道题目`);
  } catch (error) {
    toast(error.message);
  } finally {
    $("#platformSync").disabled = false;
  }
}

async function openProviders() {
  $("#settingsDlg").close();
  $("#providersDlg").showModal();
  $("#providerFind").value = "";
  try {
    await loadArmorPrompts();
    await loadProviders({});
  } catch (error) {
    toast(error.message);
  }
}

const mcpAgentIDs = ["boom","boom-worker","boom-consultant"];
const mcpURL = (id, suffix = "") => `/api/mcp/${encodeURIComponent(id)}${suffix}`;

function mcpJSON(selector, fallback, kind) {
  const source = $(selector).value.trim();
  if (!source) return structuredClone(fallback);
  let parsed;
  try { parsed = JSON.parse(source); }
  catch { throw new Error(`${kind} 必须是有效 JSON`); }
  return parsed;
}

function syncMcpType() {
  const local = $("#mcpType").value === "local";
  document.querySelectorAll("[data-mcp-local]").forEach(node => node.classList.toggle("hide", !local));
  document.querySelectorAll("[data-mcp-remote]").forEach(node => node.classList.toggle("hide", local));
}

function renderMcpAgents(selected = []) {
  const allowed = new Set(selected);
  $("#mcpAgents").innerHTML = mcpAgentIDs.map(id =>
    `<label><input type="checkbox" data-mcp-agent="${id}" ${allowed.has(id) ? "checked" : ""}>${id}</label>`
  ).join("");
}

function renderMcpEditor() {
  const draft = mcpDraft;
  if (!draft) return;
  $("#mcpSelect").innerHTML = mcpCatalog.length
    ? mcpCatalog.map(server => `<option value="${esc(server.id)}" ${server.id === mcpSelected ? "selected" : ""}>${esc(server.name)} · ${esc(server.runtime?.status || "unknown")}</option>`).join("")
    : '<option value="">尚未配置</option>';
  $("#mcpID").value = draft.id || "";
  $("#mcpID").disabled = !mcpNew;
  $("#mcpName").value = draft.name || "";
  $("#mcpType").value = draft.type || "remote";
  $("#mcpTimeout").value = draft.timeout || 5000;
  $("#mcpEnabled").checked = draft.enabled !== false;
  $("#mcpURL").value = draft.url || "";
  $("#mcpHeaders").value = JSON.stringify(draft.headers || {}, null, 2);
  $("#mcpOAuth").checked = draft.oauth !== false;
  $("#mcpCommand").value = JSON.stringify(draft.command || [], null, 2);
  $("#mcpEnvironment").value = JSON.stringify(draft.environment || {}, null, 2);
  renderMcpAgents(draft.agents || ["boom","boom-worker"]);
  syncMcpType();
  const status = draft.runtime?.status || (mcpNew ? "尚未保存" : "unknown");
  const detail = draft.runtime?.error ? ` · ${draft.runtime.error}` : "";
  $("#mcpStatus").textContent = `${draft.name || "新 MCP Server"} · ${draft.type || "remote"} · ${status}${detail}`;
  $("#mcpDelete").disabled = mcpNew;
  $("#mcpTest").disabled = mcpNew;
  const remoteOAuth = draft.type === "remote" && draft.oauth !== false && !mcpNew;
  $("#mcpAuth").classList.toggle("hide", !remoteOAuth || status === "connected");
  $("#mcpAuthRemove").classList.toggle("hide", !remoteOAuth);
}

function newMcpServer() {
  mcpSelected = "";
  mcpNew = true;
  mcpDraft = {
    id:"", name:"", type:"remote", enabled:true, timeout:5000,
    agents:["boom","boom-worker"], url:"", headers:{}, oauth:false,
  };
  renderMcpEditor();
  $("#mcpID").focus();
}

async function loadMcpServers({select = mcpSelected} = {}) {
  const result = await api("/api/mcp");
  mcpCatalog = result.servers || [];
  const next = mcpCatalog.find(server => server.id === select) || mcpCatalog[0];
  if (!next) return newMcpServer();
  mcpSelected = next.id;
  mcpNew = false;
  mcpDraft = structuredClone(next);
  renderMcpEditor();
}

function readMcpDraft() {
  const id = $("#mcpID").value.trim();
  const type = $("#mcpType").value;
  const agents = [...document.querySelectorAll("[data-mcp-agent]:checked")].map(node => node.dataset.mcpAgent);
  if (!id) throw new Error("Server ID 不能为空");
  if (!agents.length) throw new Error("至少允许一个 Boom Agent");
  const base = {
    id,
    name:$("#mcpName").value.trim() || id,
    type,
    enabled:$("#mcpEnabled").checked,
    timeout:Number($("#mcpTimeout").value),
    agents,
  };
  if (type === "local") {
    const command = mcpJSON("#mcpCommand", [], "命令");
    const environment = mcpJSON("#mcpEnvironment", {}, "环境变量映射");
    if (!Array.isArray(command) || !command.length || command.some(item => typeof item !== "string"))
      throw new Error("本地命令必须是非空字符串数组");
    if (!environment || Array.isArray(environment) || typeof environment !== "object")
      throw new Error("环境变量映射必须是 JSON 对象");
    return {...base, command, environment};
  }
  const headers = mcpJSON("#mcpHeaders", {}, "HTTP Headers");
  if (!headers || Array.isArray(headers) || typeof headers !== "object")
    throw new Error("HTTP Headers 必须是 JSON 对象");
  return {
    ...base,
    url:$("#mcpURL").value.trim(),
    headers,
    oauth:$("#mcpOAuth").checked ? {} : false,
  };
}

async function saveMcpServer() {
  try {
    const server = readMcpDraft();
    $("#mcpSave").disabled = true;
    const result = await api(mcpURL(server.id), {
      method:"PUT", body:JSON.stringify({server}),
    });
    mcpSelected = result.server.id;
    mcpNew = false;
    await loadMcpServers({select:mcpSelected});
    toast("MCP 配置已保存并重载 OpenCode");
  } catch (error) { toast(error.message); }
  finally { $("#mcpSave").disabled = false; }
}

async function testMcpServer() {
  if (!mcpSelected || mcpNew) return;
  try {
    $("#mcpTest").disabled = true;
    const result = await api(mcpURL(mcpSelected, "/test"), {method:"POST", body:"{}"});
    await loadMcpServers({select:mcpSelected});
    toast(`MCP 连接状态：${result.status.status}`);
  } catch (error) { toast(error.message); }
  finally { $("#mcpTest").disabled = false; }
}

async function deleteMcpServer() {
  if (!mcpSelected || mcpNew || !confirm(`删除 MCP Server ${mcpSelected}？`)) return;
  try {
    await api(mcpURL(mcpSelected), {method:"DELETE"});
    mcpSelected = "";
    await loadMcpServers({select:""});
    toast("MCP Server 已删除");
  } catch (error) { toast(error.message); }
}

async function authenticateMcpServer() {
  if (!mcpSelected || mcpNew) return;
  try {
    await api(mcpURL(mcpSelected, "/oauth"), {method:"POST", body:"{}"});
    const code = prompt("浏览器授权完成后，粘贴授权码。若服务已自动完成回调，可取消。", "");
    if (code?.trim()) await api(mcpURL(mcpSelected, "/oauth/callback"), {
      method:"POST", body:JSON.stringify({code:code.trim()}),
    });
    await loadMcpServers({select:mcpSelected});
  } catch (error) { toast(error.message); }
}

async function removeMcpOAuth() {
  if (!mcpSelected || mcpNew) return;
  try {
    await api(mcpURL(mcpSelected, "/oauth"), {method:"DELETE"});
    await loadMcpServers({select:mcpSelected});
    toast("MCP OAuth 凭据已移除");
  } catch (error) { toast(error.message); }
}

async function openMcpServers() {
  $("#settingsDlg").close();
  $("#mcpDlg").showModal();
  try { await loadMcpServers({}); }
  catch (error) { toast(error.message); }
}

function renderArmorPromptEditor() {
  $("#armorPromptList").innerHTML = armorPromptDraft.length
    ? armorPromptDraft.map((prompt, index) => `<div class="armor-card" data-armor-index="${index}">
      <input data-armor-name value="${esc(prompt.name)}" maxlength="120"
        placeholder="提示词名称，例如：通用越狱">
      <button class="btn tiny armor-remove" data-remove-armor="${index}" type="button">删除</button>
      <textarea data-armor-text maxlength="100000" placeholder="输入要置于 Agent 提示词最前面的系统提示词…">${
        esc(prompt.prompt)}</textarea>
    </div>`).join("")
    : '<div class="armor-empty">还没有破甲提示词。<br>点击“＋ 提示词”创建第一项。</div>';
}

function readArmorPromptDraft() {
  armorPromptDraft = [...document.querySelectorAll("#armorPromptList .armor-card")].map(row => {
    const original = armorPromptDraft[Number(row.dataset.armorIndex)] || {};
    return {
      id:original.id,
      name:row.querySelector("[data-armor-name]").value.trim(),
      prompt:row.querySelector("[data-armor-text]").value.trim(),
    };
  });
  return armorPromptDraft;
}

async function openArmorPrompts() {
  $("#settingsDlg").close();
  $("#armorPromptsDlg").showModal();
  try {
    await loadArmorPrompts();
    armorPromptDraft = structuredClone(armorPromptCatalog);
    renderArmorPromptEditor();
  } catch (error) {
    toast(error.message);
  }
}

async function saveArmorPrompts() {
  try {
    const prompts = readArmorPromptDraft();
    if (prompts.some(prompt => !prompt.name || !prompt.prompt))
      throw new Error("每条破甲提示词都需要名称和内容");
    $("#armorPromptsSave").disabled = true;
    const result = await api("/api/armor-prompts", {
      method:"PUT",
      body:JSON.stringify({prompts}),
    });
    armorPromptCatalog = result.prompts || [];
    armorPromptDraft = structuredClone(armorPromptCatalog);
    $("#armorPromptsDlg").close();
    $("#settingsDlg").showModal();
    toast("破甲提示词已保存");
  } catch (error) {
    toast(error.message);
  } finally {
    $("#armorPromptsSave").disabled = false;
  }
}

function newProvider() {
  providerSelected = "";
  providerNew = true;
  providerDraft = {
    id:"",
    name:"",
    custom:true,
    disabled:false,
    connected:false,
    configured:false,
    npm:"@ai-sdk/openai-compatible",
    driver:"openai-compatible",
    api:"",
    baseURL:"",
    models:[],
    authMethods:[{type:"api", label:"API Key", index:0}],
  };
  renderProviderList();
  renderProviderEditor();
  $("#providerID").focus();
}

function readProviderDraft() {
  if (!providerDraft) throw new Error("没有选中 Provider");
  const models = [...document.querySelectorAll("#providerModels .model-row")].map(row => {
    const index = Number(row.dataset.modelIndex);
    const original = providerDraft.models[index] || {};
    const priceInput = row.querySelector("[data-model-price-input]").value;
    const priceOutput = row.querySelector("[data-model-price-output]").value;
    if ((priceInput === "") !== (priceOutput === ""))
      throw new Error("模型价格需要同时填写输入和输出 $/M");
    if (priceInput !== "" && (!Number.isFinite(Number(priceInput)) || Number(priceInput) < 0 ||
      !Number.isFinite(Number(priceOutput)) || Number(priceOutput) < 0))
      throw new Error("模型价格必须是非负数");
    return {
      id: row.querySelector("[data-model-id]").value.trim(),
      name: row.querySelector("[data-model-name]").value.trim(),
      context: Number(row.querySelector("[data-model-context]").value),
      output: Number(row.querySelector("[data-model-output]").value),
      reasoning: row.querySelector("[data-model-reasoning]").checked,
      attachment: row.querySelector("[data-model-attachment]").checked,
      ...(priceInput !== "" && priceOutput !== ""
        ? {pricing:{...original.pricing, input:Number(priceInput), output:Number(priceOutput)}} : {}),
      armorPrompt: row.querySelector("[data-model-armor]").value || undefined,
      enabled: row.querySelector("[data-model-enabled]").checked,
      source: original.source || "custom",
    };
  });
  const id = $("#providerID").value.trim();
  providerDraft = {
    ...providerDraft,
    id,
    name:$("#providerName").value.trim(),
    driver:providerDraft.custom ? $("#providerDriver").value : providerDraft.driver,
    npm:$("#providerNpm").value.trim() || undefined,
    api:$("#providerApi").value.trim() || undefined,
    baseURL:$("#providerBaseURL").value.trim() || undefined,
    models,
  };
  return {
    id,
    custom: providerDraft.custom === true,
    disabled:false,
    name:providerDraft.name,
    ...(providerDraft.driver ? {driver:providerDraft.driver} : {}),
    npm:providerDraft.npm,
    api:providerDraft.api,
    baseURL:providerDraft.baseURL,
    models:models.map(model => ({
      id:model.id,
      name:model.name,
      context:model.context,
      output:model.output,
      reasoning:model.reasoning,
      attachment:model.attachment,
      pricing:model.pricing,
      armorPrompt:model.armorPrompt,
    })),
    hiddenModels:models.filter(model => !model.enabled).map(model => model.id),
  };
}

async function applyOpenCodeProvider() {
  if (!providerDraft) return;
  const button = $("#providerModelsFetch");
  const originalLabel = button.textContent;
  try {
    const provider = readProviderDraft();
    if (!provider.id) throw new Error("请先填写 Provider ID");
    const apiKey = $("#providerApiKey").value.trim();
    button.disabled = true;
    button.textContent = "OpenCode 应用中…";
    $("#providerSave").disabled = true;
    // OpenCode owns Provider discovery and its model catalog. Boom only submits the
    // form configuration and then asks the runtime for its current catalog.
    const saved = await api(providerURL(provider.id), {
      method:"PUT",
      body:JSON.stringify({provider, apiKey:apiKey || undefined}),
    });
    providerSelected = provider.id;
    providerNew = false;
    providerDraft = structuredClone(saved.provider);
    await Promise.all([
      loadProviders({select:provider.id}),
      loadState({replaceSettings:true}),
    ]);
    toast("OpenCode 已应用 Provider 配置并刷新模型目录");
  } catch (error) {
    toast(`OpenCode Provider 应用失败：${error.message}`);
  } finally {
    const current = $("#providerModelsFetch");
    current.disabled = false;
    current.textContent = originalLabel;
    $("#providerSave").disabled = false;
  }
}

async function saveProvider() {
  try {
    const provider = readProviderDraft();
    if (!provider.id) throw new Error("Provider ID 不能为空");
    const apiKey = $("#providerApiKey").value.trim();
    $("#providerSave").disabled = true;
    const result = await api(providerURL(provider.id), {
      method:"PUT",
      body:JSON.stringify({provider, apiKey:apiKey || undefined}),
    });
    providerSelected = provider.id;
    providerNew = false;
    providerDraft = structuredClone(result.provider);
    toast("Provider 已保存，运行时已重载");
    await Promise.all([loadProviders({select:provider.id}), loadState({replaceSettings:true})]);
  } catch (error) {
    toast(error.message);
  } finally {
    $("#providerSave").disabled = false;
  }
}

async function deleteProvider() {
  if (!providerDraft || providerNew) return;
  const action = providerDraft.custom ? "删除" : "禁用";
  if (!confirm(`${action} Provider ${providerDraft.name}（${providerDraft.id}）？`)) return;
  try {
    await api(providerURL(providerDraft.id), {method:"DELETE"});
    toast(`Provider 已${action}`);
    providerSelected = "";
    providerDraft = null;
    await Promise.all([loadProviders({select:""}), loadState({replaceSettings:true})]);
  } catch (error) {
    toast(error.message);
  }
}

async function removeProviderCredential() {
  if (!providerDraft || providerNew) return;
  if (!confirm(`移除 ${providerDraft.name} 的 Runtime 凭据？`)) return;
  try {
    await api(providerURL(providerDraft.id, "/credential"), {method:"DELETE"});
    toast("凭据已移除");
    await Promise.all([
      selectProvider(providerDraft.id),
      loadState({replaceSettings:true}),
    ]);
  } catch (error) {
    toast(error.message);
  }
}

async function startProviderOAuth(method) {
  if (!providerDraft || providerNew) return;
  try {
    const result = await api(providerURL(providerDraft.id, "/oauth"), {
      method:"POST",
      body:JSON.stringify({method}),
    });
    const authorization = result.authorization;
    let code;
    if (authorization.method === "code") {
      code = prompt(
        `${authorization.instructions || "请在浏览器完成授权，然后粘贴授权码。"}\n\n授权页面已打开。`,
        "",
      );
      if (code === null) return;
    } else {
      alert(authorization.instructions ||
        "授权页面已在浏览器打开。完成授权后返回 Boom，点击确定继续。");
    }
    const completed = await api(providerURL(providerDraft.id, "/oauth/callback"), {
      method:"POST",
      body:JSON.stringify({method, code:code || undefined}),
    });
    providerDraft = structuredClone(completed.provider);
    toast("OAuth 登录已完成");
    await Promise.all([
      loadProviders({select:providerDraft.id}),
      loadState({replaceSettings:true}),
    ]);
  } catch (error) {
    toast(error.message);
  }
}

/**
 * Guards every launch path against double submission.
 *
 * `startRuns` is reachable from the run button, the kebab menu, the per-category buttons and two
 * keyboard shortcuts (`r`, Enter in the hint box) — the shortcuts have no button to disable, so the
 * latch lives here rather than at each call site. `POST /api/runs` is not idempotent: a second call
 * that lands before `loadState()` returns queues the same challenge twice and pays for it twice.
 */
let launching = false;

async function startRuns(slugs, extra = {}) {
  if (!slugs.length) return toast("没有可运行的题目");
  if (launching) return;
  const button = $("#run");
  try {
    launching = true;
    button.disabled = true;
    readSettings();
    const environmentProfileId = $("#pythonEnvironment").value || snapshot?.environments?.defaultProfileId;
    if (!environmentProfileId) throw new Error("先在设置中选择默认 Python 环境");
    await api("/api/runs", {
      method:"POST",
      body:JSON.stringify({
        slugs,
        hint:extra.hint || undefined,
        newTask:extra.newTask === true,
        runIDs:extra.runID ? {[slugs[0]]:extra.runID} : undefined,
        environmentProfileId,
        executionMode: $("#executionMode").value || "managed",
      }),
    });
    toast(`${slugs.length} 题已进入运行队列`);
    await loadState();
  } catch (error) {
    toast(error.message);
  } finally {
    launching = false;
    button.disabled = false;
  }
}

async function rerun() {
  const challenge = challengeOf(selected);
  if (!challenge) return;
  const hint = $("#hint").value.trim();
  $("#hint").value = "";
  await startRuns([challenge.slug], {hint, runID:current(challenge)?.id});
}

async function startConsultation() {
  const challenge = challengeOf(selected);
  if (!challenge) return;
  const expertModels = snapshot.settings.consultModels || [];
  if (expertModels.length < 2 || expertModels.length > 4)
    return toast("请先在运行设置中选择 2–4 个会诊模型");
  const button = $("#consult");
  try {
    button.disabled = true;
    await api("/api/consultations", {
      method:"POST",
      body:JSON.stringify({
        slug:challenge.slug,
        sourceRunID:current(challenge)?.id,
        expertModels,
        model:snapshot.settings.strongModel,
        synthesizerModel:snapshot.settings.strongModel,
      }),
    });
    toast("多模型会诊已排队，综合后会自动继续求解");
    await loadState();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

/**
 * Record a verdict on a candidate.
 *
 * `run`/`flag` are explicit so a row in the flag history can be judged too, not just the current
 * task's newest candidate. `POST /api/flags` already accepts any run of the challenge and checks that
 * the flag really is one of that run's candidates.
 */
async function reviewFlag(correct, target = {}) {
  const challenge = challengeOf(selected);
  const run = target.run || displayFlagRun(challenge);
  const flag = target.flag || primary(run);
  if (!challenge || !run || !flag) return;
  if (correct && !confirm(`确认 ${challenge.slug} 的 flag 正确并归档任务？\n\n${flag}`)) return;
  const hint = $("#hint").value.trim();
  try {
    $("#flagCorrect").disabled = true;
    $("#flagWrong").disabled = true;
    await api("/api/flags", {
      method:"POST",
      body:JSON.stringify({
        slug:challenge.slug,
        runID:run.id,
        flag,
        correct,
        hint:hint || undefined,
      }),
    });
    if (!correct) $("#hint").value = "";
    toast(correct ? "Flag 已确认，主流程结束；需要时点击「生成 Writeup」" : "已否定该 Flag，并继续同一任务");
    await loadState();
  } catch (error) {
    toast(error.message);
  } finally {
    $("#flagCorrect").disabled = false;
    $("#flagWrong").disabled = false;
  }
}

async function writeupRun() {
  const challenge = challengeOf(selected);
  const run = current(challenge);
  if (!challenge || !run) return;
  try {
    $("#flagWriteup").disabled = true;
    await api("/api/runs/writeup", {
      method: "POST",
      body: JSON.stringify({ slug: challenge.slug, runID: run.id }),
    });
    toast("已排队生成 Writeup；完成后任务自动归档");
    await loadState();
  } catch (error) {
    toast(error.message);
  } finally {
    $("#flagWriteup").disabled = false;
  }
}

async function patchChallenge(challenge, change, message) {
  try {
    await api(`/api/challenges/${encodeURIComponent(challenge.slug)}`, {
      method:"PATCH", body:JSON.stringify(change),
    });
    toast(message);
    await loadState();
  } catch (error) { toast(error.message); }
}

async function openPath(kind, slug, runID, filePath) {
  try {
    await api("/api/open", {
      method:"POST",
      body:JSON.stringify({kind, slug, runID, path:filePath}),
    });
  } catch (error) { toast(error.message); }
}

function closeMenu() {
  $("#menuRoot").innerHTML = "";
  menuFor = null;
}

function openMenu(slug, x, y) {
  const challenge = challengeOf(slug);
  if (!challenge) return;
  selected = slug;
  void loadSelectedDetail();
  menuFor = slug;
  $("#menuRoot").innerHTML = `<div class="menu" style="left:${Math.max(6,x)}px;top:${Math.max(6,y)}px">
    <div class="hd">运行</div>
    <button data-action="rerun"><span>▶</span>${challenge.runs.length ? "继续当前任务" : "开始任务"}</button>
    ${challenge.runs.length ? '<button data-action="newtask"><span>＋</span>新建独立任务</button>' : ""}
    <div class="hd">模型策略</div>
    <button data-action="settings"><span>⚙</span>E ${esc(shortModel(snapshot.settings.economyModel))} / S ${esc(shortModel(snapshot.settings.strongModel))}</button>
    <hr>
    <button data-action="giveup"><span>${challenge.state === "given-up" ? "↺" : "⊘"}</span>${
      challenge.state === "given-up" ? "取消放弃" : "放弃这题"}</button>
    <button data-action="remove"><span>${challenge.state === "removed" ? "↺" : "✕"}</span>${
      challenge.state === "removed" ? "回到批次" : "从批次移除"}</button>
    <button data-action="reset"><span>⟲</span>清空运行历史</button>
    <hr><button data-action="delete" class="danger"><span>🗑</span>删除磁盘目录…</button>
  </div>`;
  const menu = $("#menuRoot").firstElementChild;
  const bounds = menu.getBoundingClientRect();
  if (bounds.bottom > innerHeight - 6) menu.style.top = `${Math.max(6, innerHeight - bounds.height - 6)}px`;
  if (bounds.right > innerWidth - 6) menu.style.left = `${Math.max(6, innerWidth - bounds.width - 6)}px`;
  menu.onclick = event => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    closeMenu();
    if (action === "rerun") void rerun();
    if (action === "newtask") {
      if (confirm(`为 ${challenge.slug} 新建一个空白任务？旧任务与产物会保留。`))
        void startRuns([challenge.slug], {newTask:true});
    }
    if (action === "settings") $("#settingsDlg").showModal();
    if (action === "giveup") void patchChallenge(challenge,
      {state:challenge.state === "given-up" ? null : "given-up"},
      challenge.state === "given-up" ? "已恢复" : "已放弃（文件保留）");
    if (action === "remove") void patchChallenge(challenge,
      {state:challenge.state === "removed" ? null : "removed"},
      challenge.state === "removed" ? "已回到批次" : "已移出批次（文件保留）");
    if (action === "reset") void resetChallenge(challenge);
    if (action === "delete") askDelete(challenge);
  };
  render();
}

async function resetChallenge(challenge) {
  if (!challenge.runs.length) return toast("该题没有运行历史");
  if (!confirm(`清空 ${challenge.slug} 的全部运行历史与 work/ 产物？`)) return;
  try {
    await api(`/api/challenges/${encodeURIComponent(challenge.slug)}/runs`, {method:"DELETE"});
    toast("运行历史已清空");
    await loadState();
  } catch (error) { toast(error.message); }
}

function askDelete(challenge) {
  deleteTarget = challenge;
  $("#delPath").textContent = `challenges/${challenge.storagePath || `${categoryOf(challenge)}/${challenge.slug}`}/ + runs/${challenge.slug}/`;
  $("#delDlg").showModal();
}

function move(offset) {
  const ordered = orderedChallenges();
  const index = ordered.findIndex(challenge => challenge.slug === selected);
  const next = ordered[Math.max(0, Math.min(ordered.length - 1, index + offset))];
  if (!next) return;
  selected = next.slug;
  render();
  scrollStreamToBottom();
  void loadSelectedDetail();
  [...document.querySelectorAll(".item")].find(node => node.dataset.slug === selected)
    ?.scrollIntoView({block:"nearest"});
}

$("#queue").onclick = event => {
  const copied = event.target.closest("[data-copy-flag]");
  if (copied) {
    event.preventDefault();
    event.stopPropagation();
    copy(copied.dataset.copyFlag, "flag 已复制");
    return;
  }
  const retry = event.target.closest("[data-retry-category]");
  if (retry) return void startRuns(challenges.filter(challenge =>
    categoryOf(challenge) === retry.dataset.retryCategory && bucket(challenge) === "attn")
    .map(challenge => challenge.slug));
  const runCategory = event.target.closest("[data-run-category]");
  if (runCategory) return void startRuns(runnableChallenges(runCategory.dataset.runCategory)
    .map(challenge => challenge.slug));
  const restore = event.target.closest("[data-restore-category]");
  if (restore) {
    void Promise.all(challenges.filter(challenge => challenge.state === "removed" &&
      categoryOf(challenge) === restore.dataset.restoreCategory)
      .map(challenge => api(`/api/challenges/${encodeURIComponent(challenge.slug)}`, {
        method:"PATCH", body:JSON.stringify({state:null}),
      }))).then(() => loadState()).catch(error => toast(error.message));
    return;
  }
  const menu = event.target.closest("[data-menu]");
  if (menu) {
    event.stopPropagation();
    const rect = menu.getBoundingClientRect();
    openMenu(menu.dataset.menu, rect.left - 160, rect.bottom + 4);
    return;
  }
  const item = event.target.closest(".item");
  if (item) {
    selected = item.dataset.slug;
    render();
    // A newly opened task starts at its newest output rather than inheriting the last one's offset.
    scrollStreamToBottom();
    void loadSelectedDetail();
    return;
  }
  // Checked last so the per-category action buttons inside the header keep working.
  const group = event.target.closest(".grp[data-category]");
  if (group) {
    const category = group.dataset.category;
    if (collapsed.has(category)) collapsed.delete(category);
    else collapsed.add(category);
    renderQueue();
  }
};

$("#queue").oncontextmenu = event => {
  const item = event.target.closest(".item");
  if (!item) return;
  event.preventDefault();
  openMenu(item.dataset.slug, event.clientX, event.clientY);
};

document.addEventListener("click", event => {
  if (menuFor && !event.target.closest(".menu") && !event.target.closest("[data-menu]"))
    closeMenu();
}, true);

/**
 * Dismiss a lingering text selection.
 *
 * `user-select:all` on the flag means a single click selects the whole value, and WKWebView keeps that
 * selection until something replaces it — clicking elsewhere on a non-text area never cleared it. Only
 * collapse a selection that lies outside the element being pressed, so click-dragging to select and
 * clicking inside a selectable field still behave normally.
 */
document.addEventListener("pointerdown", event => {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  const anchor = selection.anchorNode;
  const inside = anchor && target instanceof Node &&
    (target.contains(anchor.nodeType === Node.TEXT_NODE ? anchor.parentNode : anchor) ||
      target === anchor);
  if (!inside) selection.removeAllRanges();
}, true);

$("#tabs").onclick = event => {
  const button = event.target.closest("[data-p]");
  if (!button) return;
  $("#tabs").querySelectorAll("button").forEach(node => node.classList.toggle("on", node === button));
  document.querySelectorAll(".pane").forEach(pane =>
    pane.classList.toggle("on", pane.id === `p-${button.dataset.p}`));
  // A hidden pane has no scroll height, so opening the stream must place it at the tail explicitly.
  if (button.dataset.p === "stream") scrollStreamToBottom();
};

$("#fmt").oninput = event => {
  const broken = event.target.value.trim() && formatRegex() === false;
  event.target.classList.toggle("bad", !!broken);
  if (!broken) render();
};
$("#economyModel").onchange = () => render();
$("#strongModel").onchange = () => render();
$("#pythonEnvironment").onchange = () => syncEnvironmentSelect();
$("#condaDiscover").onclick = async () => {
  try {
    const result = await api("/api/environments/discover", {method:"POST", body:"{}"});
    snapshot.environments = result.store;
    syncEnvironmentSelect();
    toast(`发现并探测 ${result.discovered} 个 Conda 环境`);
  } catch (error) { toast(error.message); }
};
$("#pythonAdd").onclick = async () => {
  const interpreter = $("#pythonInterpreter").value.trim();
  if (!interpreter) return toast("请输入 Python 解释器路径");
  try {
    const result = await api("/api/environments", {
      method:"POST",
      body:JSON.stringify({interpreter, makeDefault:true}),
    });
    snapshot.environments = result.store;
    $("#pythonEnvironment").value = result.profile.id;
    syncEnvironmentSelect();
    toast(`环境 ${result.profile.displayName} 已通过测试`);
  } catch (error) { toast(error.message); }
};
$("#find").oninput = event => { filter = event.target.value; renderQueue(); };
$("#copyFlag").onclick = () => {
  const flag = primary(displayFlagRun(challengeOf(selected)));
  if (flag) copy(flag, "flag 已复制");
};
$("#pending").onclick = () => {
  const rows = challenges.map(challenge => [challenge,latestFlagRun(challenge)])
    .filter(([,run]) => run && primary(run) && run.taskStatus !== "archived" && !run.confirmedFlag)
    .map(([challenge,run]) => `${challenge.slug}\t${primary(run)}`);
  if (!rows.length) return toast("还没有得到任何 flag");
  copy(rows.join("\n"), `已复制 ${rows.length} 个 flag`);
};
$("#settingsOpen").onclick = () => $("#settingsDlg").showModal();
$("#providersOpen").onclick = () => void openProviders();
$("#mcpOpen").onclick = () => void openMcpServers();
$("#platformsOpen").onclick = () => void openPlatforms();
$("#armorPromptsOpen").onclick = () => void openArmorPrompts();
$("#settingsCancel").onclick = () => {
  $("#settingsDlg").close();
  void loadState({replaceSettings:true});
};
$("#settingsSave").onclick = () => void saveSettings();
$("#armorPromptsCancel").onclick = () => {
  $("#armorPromptsDlg").close();
  armorPromptDraft = [];
  $("#settingsDlg").showModal();
};
$("#armorPromptAdd").onclick = () => {
  readArmorPromptDraft();
  armorPromptDraft.push({
    id:crypto.randomUUID(),
    name:"",
    prompt:"",
  });
  renderArmorPromptEditor();
  const cards = document.querySelectorAll("#armorPromptList .armor-card");
  cards[cards.length - 1]?.querySelector("[data-armor-name]")?.focus();
};
$("#armorPromptList").onclick = event => {
  const button = event.target.closest("[data-remove-armor]");
  if (!button) return;
  readArmorPromptDraft();
  armorPromptDraft.splice(Number(button.dataset.removeArmor), 1);
  renderArmorPromptEditor();
};
$("#armorPromptsSave").onclick = () => void saveArmorPrompts();
$("#providersClose").onclick = () => {
  $("#providersDlg").close();
  providerDraft = null;
  providerSelected = "";
  $("#settingsDlg").showModal();
};
$("#mcpClose").onclick = () => {
  $("#mcpDlg").close();
  mcpDraft = null;
  mcpSelected = "";
  $("#settingsDlg").showModal();
};
$("#mcpSelect").onchange = event => {
  const selectedServer = mcpCatalog.find(server => server.id === event.target.value);
  if (!selectedServer) return;
  mcpSelected = selectedServer.id;
  mcpNew = false;
  mcpDraft = structuredClone(selectedServer);
  renderMcpEditor();
};
$("#mcpReload").onclick = () => void loadMcpServers({}).catch(error => toast(error.message));
$("#mcpNew").onclick = () => newMcpServer();
$("#mcpType").onchange = () => syncMcpType();
$("#mcpSave").onclick = () => void saveMcpServer();
$("#mcpTest").onclick = () => void testMcpServer();
$("#mcpDelete").onclick = () => void deleteMcpServer();
$("#mcpAuth").onclick = () => void authenticateMcpServer();
$("#mcpAuthRemove").onclick = () => void removeMcpOAuth();
$("#platformsClose").onclick = () => {
  $("#platformsDlg").close();
  $("#settingsDlg").showModal();
};
$("#platformSelect").onchange = event => void selectPlatform(event.target.value);
$("#platformReload").onclick = () => void loadPlatforms({}).catch(error => toast(error.message));
$("#platformAdapt").onclick = () => void adaptPlatform();
$("#platformSave").onclick = () => void savePlatformManifest();
$("#platformSync").onclick = () => void syncPlatform();
$("#platformCatalogLoad").onclick = () => void loadPlatformCatalog({page:1, resetSelection:true});
$("#platformChallengeSearch").onkeydown = event => {
  if (event.key === "Enter") void loadPlatformCatalog({page:1, resetSelection:true});
};
$("#platformChallengeCategory").onchange = () => void loadPlatformCatalog({page:1, resetSelection:true});
$("#platformChallengeDifficulty").onchange = () => void loadPlatformCatalog({page:1, resetSelection:true});
$("#platformSelectAll").onchange = event => {
  platformRemoteSelection = {all:event.target.checked, ids:new Set()};
  renderPlatformCatalog();
};
$("#platformSelectionClear").onclick = () => {
  platformRemoteSelection = {all:false, ids:new Set()};
  renderPlatformCatalog();
};
$("#platformChallengeList").onchange = event => {
  const checkbox = event.target.closest('input[type="checkbox"]');
  const row = checkbox?.closest("[data-platform-challenge]");
  if (!row) return;
  const id = row.dataset.platformChallenge;
  if (platformRemoteSelection.all) {
    if (checkbox.checked) platformRemoteSelection.ids.delete(id);
    else platformRemoteSelection.ids.add(id);
  } else if (checkbox.checked) platformRemoteSelection.ids.add(id);
  else platformRemoteSelection.ids.delete(id);
  renderPlatformCatalog();
};
$("#platformCatalogPrev").onclick = () => {
  if (platformRemoteCatalog.page > 1) void loadPlatformCatalog({page:platformRemoteCatalog.page - 1});
};
$("#platformCatalogNext").onclick = () => {
  const pages = Math.ceil(platformRemoteCatalog.total / platformRemoteCatalog.pageSize);
  if (platformRemoteCatalog.page < pages) void loadPlatformCatalog({page:platformRemoteCatalog.page + 1});
};
$("#providerFind").oninput = () => renderProviderList();
$("#providerList").onclick = event => {
  const button = event.target.closest("[data-provider]");
  if (button) void selectProvider(button.dataset.provider);
};
$("#providerAdd").onclick = () => newProvider();
$("#providerModelsFetch").onclick = () => void applyOpenCodeProvider();
$("#providerModelAdd").onclick = () => {
  if (!providerDraft) return;
  readProviderDraft();
  providerDraft.models.push({
    id:"",
    name:"",
    context:300000,
    output:16384,
    reasoning:false,
    attachment:false,
    armorPrompt:undefined,
    enabled:true,
    source:"custom",
  });
  renderProviderModels();
  const rows = document.querySelectorAll("#providerModels .model-row");
  rows[rows.length - 1]?.querySelector("[data-model-id]")?.focus();
};
$("#providerModels").onclick = event => {
  const button = event.target.closest("[data-remove-model]");
  if (!button || !providerDraft) return;
  readProviderDraft();
  providerDraft.models.splice(Number(button.dataset.removeModel), 1);
  renderProviderModels();
};
$("#providerAuthMethods").onclick = event => {
  const button = event.target.closest("[data-provider-oauth]");
  if (button) void startProviderOAuth(Number(button.dataset.providerOauth));
};
$("#providerDiscard").onclick = () => {
  if (providerNew) {
    providerDraft = null;
    providerNew = false;
    renderProviderEditor();
    renderProviderList();
  } else if (providerSelected) {
    void selectProvider(providerSelected);
  }
};
$("#providerSave").onclick = () => void saveProvider();
$("#providerDelete").onclick = () => void deleteProvider();
$("#providerCredentialRemove").onclick = () => void removeProviderCredential();
$("#rerun").onclick = () => void rerun();
$("#consult").onclick = () => void startConsultation();
$("#flagCorrect").onclick = () => void reviewFlag(true);
$("#flagWrong").onclick = () => void reviewFlag(false);
$("#flagWriteup").onclick = () => void writeupRun();
$("#stopOne").onclick = async () => {
  const challenge = challengeOf(selected);
  if (!challenge) return;
  const button = $("#stopOne");
  try {
    button.disabled = true;
    const result = await api("/api/runs/stop", {
      method:"POST",
      body:JSON.stringify({slug:challenge.slug}),
    });
    toast(result.stopped ? `已请求停止 ${challenge.slug}` : `${challenge.slug} 当前没有运行`);
    await loadState();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
};
$("#switchEnvironment").onclick = () => void switchTaskEnvironment();
$("#run").onclick = () => void startRuns(runnableChallenges().map(challenge => challenge.slug));
$("#halt").onclick = async () => {
  const button = $("#halt");
  try {
    button.disabled = true;
    const result = await api("/api/runs/stop", {method:"POST", body:"{}"});
    toast(`已请求停止 ${result.stopped} 个运行`);
    await loadState();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
};
$("#rescan").onclick = () => void loadState().then(() => toast(`已扫描 ${challenges.length} 题`));
$("#pick").onclick = async () => {
  const root = await chooseDirectory({
    title:"选择包含 challenges/ 的 Boom 题库根目录",
    initial:snapshot?.root || "",
  });
  if (!root) return;
  try {
    await api("/api/root", {method:"POST", body:JSON.stringify({root})});
    settingsLoaded = false;
    selected = "";
    await loadState({replaceSettings:true});
  } catch (error) { toast(error.message); }
};
$("#addCh").onclick = async () => {
  const source = await chooseDirectory({
    title:"选择要导入的题目目录",
    initial:snapshot?.root || "",
  });
  if (!source) return;
  const parent = source.replaceAll("\\", "/").split("/").filter(Boolean).slice(-2, -1)[0]?.toUpperCase();
  const chosen = categoryOrder.includes(parent) ? parent : prompt(
    `题目分类（${categoryOrder.join(" / ")}）`,
    "OTHER",
  );
  if (chosen === null) return;
  const category = String(chosen).trim().toUpperCase();
  if (!categoryOrder.includes(category)) return toast(`不支持的题目分类：${chosen}`);
  try {
    const imported = await api("/api/challenges/import", {
      method:"POST", body:JSON.stringify({source, category}),
    });
    toast(`题目已导入到 ${imported.category}`);
    await loadState();
  } catch (error) { toast(error.message); }
};
$("#openWork").onclick = () => {
  const run = current(challengeOf(selected));
  if (!run) return toast("请先选择一次运行");
  void openPath("work", selected, run.id);
};
$("#hint").onkeydown = event => {
  if (event.key === "Enter") { event.preventDefault(); void rerun(); }
};

$("#delCancel").onclick = () => $("#delDlg").close();
$("#delSoft").onclick = () => {
  $("#delDlg").close();
  if (deleteTarget) void patchChallenge(deleteTarget, {state:"removed"}, "已改为从批次移除");
};
$("#delOk").onclick = async () => {
  $("#delDlg").close();
  if (!deleteTarget) return;
  try {
    await api(`/api/challenges/${encodeURIComponent(deleteTarget.slug)}`, {
      method:"DELETE", body:JSON.stringify({confirm:true}),
    });
    toast("题目及其运行历史已删除");
    deleteTarget = null;
    selected = "";
    await loadState();
  } catch (error) { toast(error.message); }
};

let dragDepth = 0;
addEventListener("dragenter", event => {
  event.preventDefault();
  if (++dragDepth === 1) $("#drop").classList.remove("hide");
});
addEventListener("dragover", event => event.preventDefault());
addEventListener("dragleave", event => {
  event.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; $("#drop").classList.add("hide"); }
});
addEventListener("drop", event => {
  event.preventDefault();
  dragDepth = 0;
  $("#drop").classList.add("hide");
  toast("请点「+ 题目」使用目录选择器");
});

document.addEventListener("keydown", event => {
  if ($("#settingsDlg").open || $("#providersDlg").open || $("#mcpDlg").open ||
    $("#platformsDlg").open || $("#armorPromptsDlg").open) {
    return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
  if (event.key === "Escape") {
    if (typing) { event.target.blur(); return; }
    if (menuFor) { closeMenu(); return; }
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  const challenge = challengeOf(selected);
  if (event.key === "j" || event.key === "ArrowDown") { event.preventDefault(); move(1); }
  else if (event.key === "k" || event.key === "ArrowUp") { event.preventDefault(); move(-1); }
  else if (event.key === "c") { event.preventDefault(); $("#copyFlag").click(); }
  else if (event.key === "y") { event.preventDefault(); $("#pending").click(); }
  else if (event.key === "r") { event.preventDefault(); void rerun(); }
  else if (event.key === "f") { event.preventDefault(); $("#fmt").focus(); }
  else if (event.key === "/") { event.preventDefault(); $("#find").focus(); }
  else if (event.key === "h") { event.preventDefault(); $("#hint").focus(); }
  else if (event.key === "m" && challenge) {
    event.preventDefault();
    openMenu(challenge.slug, 220, 180);
  } else if (event.key === "x" && challenge) {
    event.preventDefault();
    void patchChallenge(challenge,
      {state:challenge.state === "given-up" ? null : "given-up"},
      challenge.state === "given-up" ? "已恢复" : "已放弃");
  } else if (event.key === "-" && challenge) {
    event.preventDefault();
    void patchChallenge(challenge,
      {state:challenge.state === "removed" ? null : "removed"},
      challenge.state === "removed" ? "已恢复" : "已移出批次");
  }
});

void loadState({replaceSettings:true});
// Event updates do not arrive every second, so a timer advances each live task's elapsed time. It
// patches the existing rows instead of calling renderQueue(): rebuilding the list once a second
// swallowed clicks, because press and release landed on different DOM nodes.
setInterval(() => {
  if (!snapshot) return;
  const live = challenges.filter(challenge => isLive(current(challenge)));
  if (!live.length) return;
  for (const challenge of live) {
    if (!patchQueueRow(challenge)) {
      renderQueue();
      break;
    }
  }
}, 1_000);
})();
