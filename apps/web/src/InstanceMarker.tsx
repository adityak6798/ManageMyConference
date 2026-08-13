/** The environment is product-visible state: local and deployed demos never share data. */
export function instanceLabel(hostname = window.location.hostname) {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1")
    return "Local instance";
  if (hostname === "project-greenroom-api.adityak6798.workers.dev") return "Deployed demo";
  return "Hosted instance";
}

export function InstanceMarker() {
  return <span className="instance-marker">{instanceLabel()}</span>;
}
