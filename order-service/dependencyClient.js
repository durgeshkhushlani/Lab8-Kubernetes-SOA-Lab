// Thin wrapper around fetch for calling other microservices (User Service, Product Service).
// Centralizes the timeout/error-shape handling from section 10 of the handout ("Inter-Service
// Error Handling"): a dependency that never responds must not hang this service forever, and a
// dependency that's simply down must surface as a clean 503, not an unhandled exception.

const TIMEOUT_MS = 3000;

class DependencyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status; // 404 (resource missing) or 503 (dependency unreachable/timed out)
  }
}

async function fetchResource(baseUrl, path, resourceLabel) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
  } catch (err) {
    // Covers connection-refused (service down/unreachable) and our own abort (timeout) alike -
    // from the caller's point of view both mean "the dependency didn't answer in time."
    throw new DependencyError(`${resourceLabel} service is unavailable`, 503);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) {
    throw new DependencyError(`${resourceLabel} not found`, 404);
  }
  if (!response.ok) {
    throw new DependencyError(`${resourceLabel} service returned an unexpected error`, 503);
  }
  return response.json();
}

module.exports = { fetchResource, DependencyError };
