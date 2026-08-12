import sanitizeHtmlLibrary from "sanitize-html";
import { ResourceEmbedDeniedError } from "../../application/content/content-service";

const allowedTags = [
  "a",
  "blockquote",
  "br",
  "code",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

/** Parser-backed security boundary for organizer-authored markup rendered to speakers. */
export function sanitizeResourceHtml(input: string): string {
  return sanitizeHtmlLibrary(input, {
    allowedTags,
    allowedAttributes: { a: ["href", "title", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: { ...attributes, rel: "noopener noreferrer" },
      }),
    },
    disallowedTagsMode: "discard",
  });
}

/** Accept one iframe only, and only when its HTTPS source host is explicitly allowlisted. */
export function sanitizeResourceEmbed(input: string, allowedHosts: readonly string[]): string {
  if (!input.trim()) return "";
  const sources: string[] = [];
  sanitizeHtmlLibrary(input, {
    allowedTags: ["iframe"],
    allowedAttributes: { iframe: ["src", "title", "width", "height"] },
    allowedSchemes: ["https"],
    exclusiveFilter(frame) {
      const source = frame.attribs.src;
      if (source) sources.push(source);
      return false;
    },
  });
  if (sources.length !== 1) throw new ResourceEmbedDeniedError("Embed must contain one iframe");
  let url: URL;
  try {
    url = new URL(sources[0] ?? "");
  } catch {
    throw new ResourceEmbedDeniedError("Embed URL is invalid");
  }
  if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname.toLowerCase()))
    throw new ResourceEmbedDeniedError(
      `Embeds from ${url.hostname || "this host"} are not allowed`,
    );
  return sanitizeHtmlLibrary(input, {
    allowedTags: ["iframe"],
    allowedAttributes: { iframe: ["src", "title", "width", "height"] },
    allowedSchemes: ["https"],
  });
}
