import { defineEventHandler } from "h3";
import { proxyToBackend } from "../../utils/backendProxy";

// Forward every /api/** request to the backend (sends the first-party session cookie).
export default defineEventHandler((event) => proxyToBackend(event));
