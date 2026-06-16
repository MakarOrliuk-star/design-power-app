import { Router } from "express";

export const auditorRouter = Router();

// Extract the base worker URL from the environment variable configuration
const workerStreamUrl = process.env.PYTHON_WORKER_URL || "http://localhost:8000/audit/stream";
const workerBaseUrl = workerStreamUrl.replace("/audit/stream", "");

// 1. Streams campaign audit progress and final report using Server-Sent Events (SSE)
auditorRouter.post("/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  req.setTimeout(0);

  try {
    const response = await fetch(`${workerBaseUrl}/audit/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    if (!response.ok || !response.body) {
      res.write(`data: ${JSON.stringify({ type: "error", msg: `Worker error: HTTP ${response.status}` })}\n\n`);
      return res.end();
    }

    // @ts-ignore - native fetch stream reader compatibility for Node 18+
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value));
    }

    res.end();
  } catch (error: any) {
    console.error("Proxy Stream Failure:", error);
    res.write(`data: ${JSON.stringify({ type: "error", msg: error.message || "Internal gateway proxy error" })}\n\n`);
    res.end();
  }
});

// 2. Proxies keyword searching inside campaign configuration payloads
auditorRouter.post("/search-campaigns", async (req, res) => {
  try {
    const response = await fetch(`${workerBaseUrl}/brands/search-campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error: any) {
    console.error("Proxy Search Campaigns Failure:", error);
    res.status(500).json({ status: "error", message: error.message || "Failed to reach auditor worker" });
  }
});

// 3. Proxies mass dictionary value extraction for specific brand criteria
auditorRouter.post("/bulk-labels", async (req, res) => {
  try {
    const response = await fetch(`${workerBaseUrl}/brands/bulk-labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error: any) {
    console.error("Proxy Bulk Labels Failure:", error);
    res.status(500).json({ status: "error", message: error.message || "Failed to reach auditor worker" });
  }
});

// 4. Proxies short URL tracking verification via link redirect resolution
auditorRouter.post("/resolve-links", async (req, res) => {
  try {
    const response = await fetch(`${workerBaseUrl}/brands/resolve-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error: any) {
    console.error("Proxy Resolve Links Failure:", error);
    res.status(500).json({ status: "error", message: error.message || "Failed to reach auditor worker" });
  }
});