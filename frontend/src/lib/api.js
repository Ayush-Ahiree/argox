import { API_BASE, HOSTED } from "./config.js";

// Local self-host (no Supabase config): same unauthenticated /policies
// hook_server.py has always served. Hosted: project-scoped, JWT-authed.
export function policiesUrl(project) {
  return HOSTED && project ? `${API_BASE}/projects/${project.id}/policies` : `${API_BASE}/policies`;
}

export function authHeaders(session) {
  return HOSTED && session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

// "Was this decision right?" from the Graph's step panel.
export function feedbackUrl(project) {
  return HOSTED && project ? `${API_BASE}/projects/${project.id}/feedback` : `${API_BASE}/feedback`;
}
