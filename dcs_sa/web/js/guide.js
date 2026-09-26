// The step-by-step guide (GETTING_STARTED.md) inside the app.
//
// A small Markdown reader for what that file uses: headings, paragraphs,
// nested lists, quotes, tables, rules, bold/italic, code and links.
// External links open in the system browser (target=_blank); links to other
// files of the project go to its GitHub page.

const REPO = "https://github.com/El-Pistolero/DCS_Situational_Awareness_App/blob/HEAD/";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** GitHub's heading anchors: "If something doesn't work" -> "if-something-doesnt-work". */
export function slug(text) {
  return text.toLowerCase().replace(/[*`]/g, "").replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/ /g, "-");
}

function href(url) {
  if (url.startsWith("#") || /^https?:/i.test(url)) return url;
  return REPO + url.replace(/^\.\//, "");
}

function linkTag(text, url) {
  const h = href(url);
  const ext = !h.startsWith("#");
  return `<a href="${esc(h)}"${ext ? ' target="_blank" rel="noopener"' : ""}>${text}</a>`;
}

export function inline(src) {
  const codes = [];
  let s = src.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => linkTag(t, u.replace(/&amp;/g, "&")));
  s = s.replace(/(^|[\s(>])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, pre, u) => pre + linkTag(u, u.replace(/&amp;/g, "&")));
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1<i>$2</i>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

const LIST = /^(\s*)(\d+\.|[-*])\s+(.*)$/;

/** Markdown text -> HTML string. */
export function render(md) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = [];
  let stack = []; // open lists: {indent, ordered, items: [html parts per item]}
  let quote = null;
  let blank = false;

  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  // Lists are built as nested arrays, then joined on close.
  const listHtml = (l) => {
    const tag = l.ordered ? "ol" : "ul";
    const start = l.ordered && l.start !== 1 ? ` start="${l.start}"` : "";
    return `<${tag}${start}>${l.items.map((it) => `<li>${it.join("")}</li>`).join("")}</${tag}>`;
  };
  const closeTo = (depth) => {
    while (stack.length > depth) {
      const l = stack.pop();
      const html = listHtml(l);
      if (stack.length) stack[stack.length - 1].items.at(-1).push(html);
      else out.push(html);
    }
  };
  const flushQuote = () => { if (quote) { out.push(`<blockquote>${quote.map((q) => `<p>${inline(q)}</p>`).join("")}</blockquote>`); quote = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flushPara(); flushQuote(); blank = true; continue; }
    const indent = line.match(/^\s*/)[0].length;
    const m = line.match(LIST);

    if (stack.length && !m && indent === 0) closeTo(0);
    if (stack.length && !m && indent > 0) {
      // More text for a list item: the deepest open item it is indented under.
      let d = stack.length - 1;
      while (d > 0 && stack[d].indent >= indent) d--;
      closeTo(d + 1);
      const item = stack[d].items.at(-1);
      if (blank) item.push(`<p>${inline(line.trim())}</p>`);
      else item.push(" " + inline(line.trim()));
      blank = false;
      continue;
    }
    blank = false;

    if (m) {
      flushPara(); flushQuote();
      const [, sp, marker, text] = m;
      const ind = sp.length, ordered = /\d/.test(marker);
      while (stack.length && stack.at(-1).indent > ind) closeTo(stack.length - 1);
      const top = stack.at(-1);
      if (top && top.indent === ind && top.ordered !== ordered) closeTo(stack.length - 1);
      if (!stack.length || stack.at(-1).indent < ind) stack.push({ indent: ind, ordered, start: ordered ? parseInt(marker, 10) : 1, items: [] });
      stack.at(-1).items.push([inline(text)]);
      continue;
    }
    closeTo(0);

    if (/^---+\s*$/.test(line)) { flushPara(); out.push("<hr>"); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const n = h[1].length;
      out.push(`<h${n} id="${slug(h[2])}">${inline(h[2])}</h${n}>`);
      continue;
    }
    if (line.startsWith(">")) {
      flushPara();
      (quote ||= []).push(line.replace(/^>\s?/, ""));
      continue;
    }
    if (line.startsWith("|")) {
      flushPara();
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r, k) => !(k === 1 && /^\|?[\s:|-]+$/.test(r)));
      const [head, ...rest] = body.map(cells);
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${
        rest.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    para.push(line.trim());
  }
  flushPara(); flushQuote(); closeTo(0);
  return out.join("\n");
}

async function main() {
  const box = document.getElementById("guide");
  try {
    const res = await fetch("/api/guide");
    if (!res.ok) throw new Error(`${res.status}`);
    box.innerHTML = render(await res.text());
  } catch (err) {
    box.innerHTML = `<p>The guide could not be loaded (${esc(String(err.message || err))}). It is also on the project's GitHub page: <a href="${REPO}GETTING_STARTED.md" target="_blank" rel="noopener">GETTING_STARTED.md</a>.</p>`;
    return;
  }
  // You are reading this inside the app, so it is already installed.
  const first = box.querySelector("h2");
  if (first) {
    first.insertAdjacentHTML("beforebegin", '<p class="note">You are reading this inside DCS SA, so Steps 1 and 2 (download and install) are done. ' +
      'Start at <a href="#step-3-try-it-with-a-demo-flight-no-dcs-needed">Step 3</a>.</p>');
  }
  const toc = document.getElementById("toc");
  for (const h of box.querySelectorAll("h2")) {
    toc.append(Object.assign(document.createElement("a"), { href: `#${h.id}`, textContent: h.textContent }));
  }
  if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
}

if (typeof document !== "undefined" && document.getElementById("guide")) {
  document.getElementById("back")?.addEventListener("click", () => {
    location.href = new URLSearchParams(location.search).get("from") === "live" ? "/live" : "/";
  });
  main();
}
