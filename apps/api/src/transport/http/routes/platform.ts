/** Public API discovery routes owned by the platform domain. @spec ARC-001 ENG-CI-001 */
import { eventIdParamsSchema } from "@greenroom/contracts";
import { AgendaNotFoundError } from "../../../application/agenda/public";
import {
  AuthenticationRequiredError,
  CapabilityDeniedError,
} from "../../../application/identity/actor";
import openApiDocument from "../../../../../../packages/contracts/openapi.json";
import { envelope } from "../runtime";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

const routes = ["GET /openapi.json", "GET /docs", "GET /api/events/:eventId/overview"] as const;

const docsPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Greenroom API reference</title>
    <style>
      :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
      body { margin: 0 auto; max-width: 72rem; padding: 2rem; }
      header { border-bottom: 1px solid #8886; margin-bottom: 2rem; }
      article { border: 1px solid #8886; border-radius: .5rem; margin: 1rem 0; padding: 1rem; }
      code { overflow-wrap: anywhere; }
      details { margin: .75rem 0; }
      pre { background: #8881; border-radius: .25rem; overflow: auto; padding: .75rem; }
      table { border-collapse: collapse; display: block; overflow-x: auto; width: 100%; }
      th, td { border-bottom: 1px solid #8884; padding: .5rem; text-align: left; vertical-align: top; }
      .method { display: inline-block; font-weight: 700; min-width: 4rem; text-transform: uppercase; }
      .meta { display: flex; flex-wrap: wrap; gap: .5rem; }
      .pill { background: #8882; border-radius: 999px; padding: .125rem .5rem; }
      .error { color: #c33; }
    </style>
  </head>
  <body>
    <header><h1>Greenroom API reference</h1><p id="summary">Loading <a href="/openapi.json">OpenAPI JSON</a>…</p></header>
    <main id="operations" aria-live="polite"></main>
    <script>
      const summary = document.querySelector("#summary");
      const operations = document.querySelector("#operations");
      const appendJson = (parent, value) => {
        const pre = window.document.createElement("pre");
        pre.textContent = JSON.stringify(value, null, 2);
        parent.append(pre);
      };
      const appendDetails = (parent, label, value) => {
        if (value === undefined || (Array.isArray(value) && value.length === 0)) return;
        const details = window.document.createElement("details");
        const detailsSummary = window.document.createElement("summary");
        detailsSummary.textContent = label;
        details.append(detailsSummary);
        appendJson(details, value);
        parent.append(details);
      };
      fetch("/openapi.json").then((response) => {
        if (!response.ok) throw new Error("OpenAPI request failed: " + response.status);
        return response.json();
      }).then((specification) => {
        window.document.title = specification.info.title + " API reference";
        summary.textContent = specification.info.description || specification.info.title;
        for (const [path, methods] of Object.entries(specification.paths)) {
          for (const [method, operation] of Object.entries(methods)) {
            const article = window.document.createElement("article");
            const heading = window.document.createElement("h2");
            const methodLabel = window.document.createElement("span");
            methodLabel.className = "method";
            methodLabel.textContent = method;
            const pathLabel = window.document.createElement("code");
            pathLabel.textContent = path;
            heading.append(methodLabel, pathLabel);
            const description = window.document.createElement("p");
            description.textContent = operation.summary || operation.description || "";
            const metadata = window.document.createElement("div");
            metadata.className = "meta";
            for (const tag of operation.tags || []) {
              const pill = window.document.createElement("span");
              pill.className = "pill";
              pill.textContent = tag;
              metadata.append(pill);
            }
            article.append(heading, description, metadata);
            appendDetails(article, "Authentication", operation.security || specification.security);
            appendDetails(article, "Parameters", operation.parameters);
            appendDetails(article, "Request body", operation.requestBody);
            appendDetails(article, "Responses", operation.responses);
            operations.append(article);
          }
        }
        const components = window.document.createElement("article");
        const componentsHeading = window.document.createElement("h2");
        componentsHeading.textContent = "Reusable schemas and security definitions";
        components.append(componentsHeading);
        appendJson(components, specification.components || {});
        operations.append(components);
      }).catch((error) => {
        summary.textContent = "The API reference could not be loaded.";
        operations.className = "error";
        operations.textContent = error instanceof Error ? error.message : String(error);
      });
    </script>
  </body>
</html>`;

export const platformRoutes: RouteModule = {
  domain: "platform",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    app.get("/openapi.json", (context) => context.json(openApiDocument));
    app.get("/docs", (context) =>
      context.html(docsPage, 200, {
        "cache-control": "public, max-age=300",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      }),
    );
    app.get("/api/events/:eventId/overview", async (context) => {
      const parsed = eventIdParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      const { content, review, agenda, publishing, logger, auth } = dependencies;
      const actor = context.get("actor");
      const missing = (name: string) => Promise.reject(new Error(`${name} service is unavailable`));
      const settled = await Promise.allSettled([
        content?.workspace(actor, parsed.data.eventId) ?? missing("Content"),
        review?.organizerWorkspace(actor, parsed.data.eventId) ?? missing("Review"),
        agenda?.draft(actor, parsed.data.eventId) ?? missing("Agenda"),
        publishing?.preview(actor, parsed.data.eventId) ?? missing("Publishing"),
      ]);
      const refusal = settled.find(
        (result) =>
          result.status === "rejected" &&
          (result.reason instanceof AuthenticationRequiredError ||
            result.reason instanceof CapabilityDeniedError),
      );
      if (refusal?.status === "rejected") throw refusal.reason;
      const names = ["content", "review", "agenda", "publication"] as const;
      const panel = (result: PromiseSettledResult<unknown>, index: number) => {
        if (result.status === "fulfilled") return { ok: true as const, data: result.value };
        const error =
          result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        const notFound = error instanceof AgendaNotFoundError;
        if (!notFound)
          logger.error(
            {
              correlationId: context.get("correlationId"),
              operation: `overview.${names[index]}`,
              actorId: actor?.id,
              errorName: error.name,
              errorMessage: error.message,
              ...(auth.demoMode ? { errorStack: error.stack } : {}),
            },
            "request.exception",
          );
        return {
          ok: false as const,
          error: envelope(
            notFound ? "NOT_FOUND" : "INTERNAL_ERROR",
            notFound ? "No agenda has been configured." : "Something went wrong.",
            context.get("correlationId"),
          ).error,
        };
      };
      return context.json({
        content: panel(settled[0], 0),
        review: panel(settled[1], 1),
        agenda: panel(settled[2], 2),
        publication: panel(settled[3], 3),
      });
    });
  },
};
