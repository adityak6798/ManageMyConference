/**
 * The parser-backed security boundary for organizer-authored portal markup.
 *
 * Publishing's own, deliberately, rather than an import of content's `sanitizeResourceHtml`.
 * The two allowlists happen to agree today and are free to diverge: a speaker resource is read by
 * people who already hold a role on the event, while a portal page is served to anonymous
 * visitors, so the day one of them wants an `img` or an embed is the day they stop being the same
 * decision. Sharing the file would have made that divergence a change to another domain's
 * adapter.
 *
 * No `img`, no `iframe`, no `style`, no `id` or `class`. A portal page that could name a remote
 * image is a page that makes a request to a third party from an address a visitor believes is
 * ours, which is a tracking pixel however it was meant.
 *
 * @spec PRD-PUB-002
 */
import sanitizeHtmlLibrary from "sanitize-html";

const allowedTags = [
  "a",
  "blockquote",
  "br",
  "code",
  "em",
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

export function sanitizeSiteHtml(input: string): string {
  return sanitizeHtmlLibrary(input, {
    allowedTags,
    allowedAttributes: { a: ["href", "title", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      // Every outbound link, whatever the author wrote: `noopener` is what stops the opened page
      // reaching back through `window.opener`, and it is not the author's decision to make.
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: { ...attributes, rel: "noopener noreferrer" },
      }),
    },
    disallowedTagsMode: "discard",
  });
}
