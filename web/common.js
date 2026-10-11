// What the chat page and the run page share: building elements, rendering the model's
// Markdown safely, and formatting ids, money, durations and times. An ES module the
// browser loads as is; there is no build step.

/** Creates an element with an optional class and text. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/**
 * Renders the small part of Markdown the model writes (paragraphs, bullet and numbered
 * lists, bold, inline code) as HTML. The text is escaped first, so nothing the model writes
 * becomes markup. Line by line, because the model often starts a list on the line right
 * after a sentence, and often leaves a blank line between the items of one list.
 */
export function renderMarkdown(text) {
  const html = [];
  let paragraph = [];
  let list = null;
  const endParagraph = () => {
    if (paragraph.length > 0) html.push(`<p>${paragraph.join("<br>")}</p>`);
    paragraph = [];
  };
  const endList = () => {
    if (list) html.push(`<${list.tag}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (const line of text.trim().split("\n").map((l) => l.trim())) {
    const item = line.match(/^[-*] (.*)/) ?? line.match(/^\d+[.)] (.*)/);
    if (!line) {
      endParagraph();
    } else if (item) {
      const tag = /^[-*]/.test(line) ? "ul" : "ol";
      endParagraph();
      if (list?.tag !== tag) {
        endList();
        list = { tag, items: [] };
      }
      list.items.push(inline(item[1]));
    } else {
      endList();
      paragraph.push(inline(line.replace(/^#+ /, "")));
    }
  }
  endParagraph();
  endList();
  return html.join("");
}

/** The resource ids an answer asserts, as tags with the kind prefix muted. */
export function idTags(ids) {
  const list = el("ul", "ids");
  list.setAttribute("aria-label", "Resources in this answer");
  for (const id of ids) {
    const cut = id.lastIndexOf(":") + 1;
    const tag = el("li");
    tag.append(el("span", "kind", id.slice(0, cut)), id.slice(cut));
    list.append(tag);
  }
  return list;
}

/** A cost in dollars, to a tenth of a cent. */
export function money(usd) {
  return Number.isFinite(usd) ? `$${usd.toFixed(3)}` : "cost unknown";
}

/** A duration in whole seconds. */
export function seconds(ms) {
  return `${(ms / 1000).toFixed(0)} s`;
}

/** A count with its noun, singular or plural. */
export function count(n, singular, plural = `${singular}s`) {
  return `${n.toLocaleString("en")} ${n === 1 ? singular : plural}`;
}

/** An ISO timestamp as the reader's local clock time, in the reader's locale. */
export function clockTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** An ISO timestamp as the reader's local date and time, in the reader's locale. */
export function dateTime(iso) {
  return new Date(iso).toLocaleString([], {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
