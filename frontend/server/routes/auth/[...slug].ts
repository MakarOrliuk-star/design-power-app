import { defineEventHandler } from "h3";
import { proxyToBackend } from "../../utils/backendProxy";

// Forward every /auth/** request to the backend, preserving redirects + cookies.
export default defineEventHandler((event) => proxyToBackend(event));
