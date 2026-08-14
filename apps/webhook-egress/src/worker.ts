import { env } from "cloudflare:workers";
import { Container, getContainer } from "@cloudflare/containers";
import { routeRequest } from "./runtime.js";

interface Environment {
  WEBHOOK_EGRESS_CONTAINER: DurableObjectNamespace<WebhookEgressContainer>;
  WEBHOOK_EGRESS_TOKEN: string;
  WEBHOOK_EGRESS_TOKEN_PREVIOUS?: string;
}

export class WebhookEgressContainer extends Container<Environment> {
  override defaultPort = 8080;
  override sleepAfter = "30m";
  override enableInternet = true;
  override pingEndpoint = "localhost/health";
  override envVars = {
    WEBHOOK_EGRESS_TOKEN: (env as Environment).WEBHOOK_EGRESS_TOKEN,
    ...((env as Environment).WEBHOOK_EGRESS_TOKEN_PREVIOUS
      ? { WEBHOOK_EGRESS_TOKEN_PREVIOUS: (env as Environment).WEBHOOK_EGRESS_TOKEN_PREVIOUS }
      : {}),
  };
}

export default {
  fetch(request: Request, environment: Environment): Promise<Response> {
    return routeRequest(request, getContainer(environment.WEBHOOK_EGRESS_CONTAINER));
  },
};
