import asyncio
import json
import re
import requests
import sys
import threading
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse, HTMLResponse
from pydantic import BaseModel
from typing import List, Optional
from playwright.sync_api import sync_playwright
from smartico_core_prod import SmarticoCore
from uuid import uuid4

app = FastAPI(title="Smartico Auditor Worker API")

# Global in-memory storage cache for pre-compiled heavy HTML reports
REPORTS_CACHE = {}

class AuditRequest(BaseModel):
    urls: List[str]
    token: str
    use_stats: bool = True
    days_back: int = 14

class BrandSearchRequest(BaseModel):
    urls: List[str]
    keyword: str
    token: str

class BulkLabelsRequest(BaseModel):
    labels: List[str]
    keyword: str
    brand_id: str
    boapi_host: str
    token: str

class ResolveLinksRequest(BaseModel):
    links: List[str]

def search_keyword_in_dict(obj, keyword, path=""):
    kw_lower = str(keyword).lower().strip()
    matches = []
    if obj is None:
        return []

    if isinstance(obj, dict):
        for k, v in obj.items():
            matches.extend(search_keyword_in_dict(v, keyword, f"{path}.{k}" if path else k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            matches.extend(search_keyword_in_dict(v, keyword, f"{path}[{i}]"))
    else:
        val_str = str(obj)
        if val_str.strip().startswith('{') or val_str.strip().startswith('['):
            try:
                inner_json = json.loads(val_str)
                matches.extend(search_keyword_in_dict(inner_json, keyword, f"{path}(JSON)"))
            except:
                pass
        if kw_lower in val_str.lower():
            matches.append({"path": path, "value": val_str})
    return matches

@app.post("/audit/stream")
async def audit_stream(request: AuditRequest):
    """
    Processes campaign URLs securely in an isolated OS thread to prevent Playwright deadlocks.
    Streams live progress logs via asyncio.Queue with SSE Heartbeats to prevent cloud timeouts.
    """
    queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def sync_playwright_worker():
        def send_event(evt_dict):
            asyncio.run_coroutine_threadsafe(queue.put(f"data: {json.dumps(evt_dict)}\n\n"), loop)
        
        try:
            urls = [u.strip() for u in request.urls if u.strip()]
            if not urls:
                send_event({'type': 'error', 'msg': 'No valid URLs provided'})
                return

            print(" [WORKER] Initializing headless Chromium context...", flush=True)
            send_event({'type': 'progress', 'percent': 5, 'msg': 'Initializing secure headless browser environment...'})
            
            combined_html = '<div style="background: #f8fafc; padding: 20px; font-family: sans-serif;"><h1 style="text-align:center; color:#1e293b; margin-bottom: 30px;">Unified Smartico Campaign Audit Report</h1>'
            
            with sync_playwright() as p:
                browser = p.chromium.launch(
                    headless=True,
                    args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
                )
                context = browser.new_context(
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                    viewport={"width": 414, "height": 896},
                    bypass_csp=True
                )
                
                total_urls = len(urls)
                for index, current_url in enumerate(urls):
                    print(f" [WORKER] Processing campaign {index + 1}/{total_urls}: {current_url}", flush=True)
                    send_event({'type': 'progress', 'percent': int(10 + (index / total_urls) * 80), 'msg': f'Processing campaign {index + 1}/{total_urls}: {current_url}'})
                    
                    brand_match = re.search(r"smartico\.ai/(\d+)", current_url)
                    camp_match = re.search(r"(?:scheduled|head)/(\d+)", current_url)
                    
                    if not brand_match or not camp_match:
                        print(f" [WORKER] Skip invalid URL: {current_url}", flush=True)
                        send_event({'type': 'progress', 'percent': int(10 + (index / total_urls) * 80), 'msg': f'⚠️ Invalid Smartico URL skipped: {current_url}'})
                        continue

                    brand_id = brand_match.group(1)
                    camp_id = camp_match.group(1)
                    
                    env_match = re.search(r"drive(?:-(\d+))?\.smartico\.ai", current_url)
                    env_suffix = env_match.group(1) if env_match and env_match.group(1) else ""
                    boapi_host = f"boapi{env_suffix}.smartico.ai" if env_suffix else "boapi.smartico.ai"
                    drive_host = env_match.group(0) if env_match else "drive.smartico.ai"
                    
                    core = SmarticoCore(context, request.token, brand_id, boapi_host, drive_host)
                    core.headers["user-agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
                    
                    print(" [WORKER] Fetching campaign metadata...", flush=True)
                    gen_data, seg_data = core.get_campaign_metadata(camp_id, current_url)
                    if not gen_data:
                        print(f" [WORKER] Access denied or HTTP error for campaign {camp_id}", flush=True)
                        send_event({'type': 'error', 'msg': f'Unauthorized or inaccessible Campaign ID {camp_id}'})
                        browser.close()
                        return
                        
                    print(" [WORKER] Verifying context tags...", flush=True)
                    context_status = core.check_context_campaign_tag(camp_id, current_url)
                    
                    print(" [WORKER] Building live view flow map data structure...", flush=True)
                    f_nodes, f_trans, audit_period = core.get_flow_data_live(
                        camp_id,
                        log_cb=lambda m, p: print(f"   └─ Map: {m}", flush=True),
                        use_live_view=request.use_stats,
                        days_back=request.days_back
                    )
                    
                    print(" [WORKER] Downloading canvas automation nodes...", flush=True)
                    nodes = core.get_campaign_nodes(camp_id)
                    transitions_data = core.get_campaign_transitions(camp_id)
                    
                    report_data = {
                        "brand_id": brand_id, "audit_period": audit_period, "expected_data": None,
                        "general_main": gen_data if "head" not in current_url else {},
                        "general_pop": gen_data if "head" in current_url else {},
                        "segment_main": seg_data if "head" not in current_url else {},
                        "segment_pop": seg_data if "head" in current_url else {},
                        "context_status_main": context_status if "head" not in current_url else None,
                        "context_status_pop": context_status if "head" in current_url else None,
                        "interactive_flow": core.build_flow_html(f_nodes, f_trans),
                        "flow_links": [], "mc_registry": [], "condition_registry": [],
                        "settings_registry": [], "deep_analysis": [], "labels_data": {}
                    }
                    
                    nodes_by_id = {str(n["id"]): n for n in nodes}
                    TARGET_NODES = {50: "Email", 40: "Push", 60: "SMS", 30: "Pop-up", 203: "Multi-Check", 200: "WebHook", 201: "Condition Check"}
                    all_other_labels = set()
                    
                    # 🚨 ANTI-API SPAM CACHE: Store rendered emails here so we don't fetch/render them twice
                    rendered_emails_cache = {}
                    
                    print(f" [WORKER] Parsing {len(nodes)} logic blocks...", flush=True)
                    for node in nodes:
                        type_id = node.get("type_id")
                        if type_id not in TARGET_NODES: continue
                        n_type = TARGET_NODES[type_id]
                        n_name = node.get("name", "Unknown")
                        det = node.get("details", {})
                        
                        if n_type == "Multi-Check":
                            branches = []
                            for check in det.get("user_checks", []):
                                c_dict = check.get("conditions_n_readable") or {}
                                cond_str = c_dict.get("conditions_readable", "")
                                if not cond_str and c_dict.get("conditions"):
                                    translated = core.resolve_conditions_async(c_dict.get("conditions"))
                                    if translated: cond_str = translated
                                if cond_str and "()" in cond_str:
                                    cond_str = core.fix_empty_brackets_locally(cond_str, c_dict.get("conditions", []))
                                branches.append({"name": check.get("name", "Unknown"), "condition": cond_str})
                            report_data["mc_registry"].append({"name": n_name, "branches": branches})
                            
                        elif n_type == "Condition Check":
                            c_dict = det.get("conditions_n_readable") or det.get("rule") or {}
                            cond_str = c_dict.get("conditions_readable") or c_dict.get("readable") or ""
                            if not cond_str and c_dict.get("conditions"):
                                translated = core.resolve_conditions_async(c_dict.get("conditions"))
                                if translated: cond_str = translated
                            if cond_str and "()" in cond_str:
                                cond_str = core.fix_empty_brackets_locally(cond_str, c_dict.get("conditions", []))
                            report_data["condition_registry"].append({"name": n_name, "condition": cond_str})
                            
                        elif n_type in ["Email", "Push", "SMS", "Pop-up"]:
                            caps = "Respect user and global caps" if not det.get("ignore_caps") else "Ignore caps"
                            optout = "Respect Platform and Smartico" if not det.get("ignore_optout") else "Ignore Opt-out"
                            
                            timeout_str = "N/A"
                            if n_type == "Pop-up":
                                timeout_ms = det.get("delivery_timeout_ms", 0)
                                if timeout_ms > 0: timeout_str = f"{timeout_ms // 60000} minutes"

                            report_data["settings_registry"].append({
                                "name": n_name, "type": n_type, "caps": caps, "optout": optout,
                                "period_display": det.get("activity_from_time", "N/A"), "delivery_timeout": timeout_str
                            })
                            
                            res_list = det.get("resources", [])
                            if res_list:
                                res = res_list[0]
                                content = res.get("resource_content", {})
                                r_name = res.get("resource_name", "")
                                r_id = res.get("id") or res.get("resource_id")
                                
                                body_text = content.get("body", res.get("body", ""))
                                title_text = content.get("title", "")
                                link_text = content.get("action", content.get("button_url", ""))
                                subj_text = res.get("subject", "")
                                
                                actual_type = n_type
                                if n_type == "Push" and ("pwa" in n_name.lower() or "pwa" in r_name.lower()):
                                    actual_type = "Push PWA"
                                
                                email_previews = []
                                if n_type == "Email" and r_id:
                                    if r_id in rendered_emails_cache:
                                        print(f" [WORKER] Using cached email previews for node #{r_id}", flush=True)
                                        send_event({'type': 'progress', 'percent': 60, 'msg': f'♻️ Loading cached high-res renders for Email #{r_id}...'})
                                        email_previews = rendered_emails_cache[r_id]
                                    else:
                                        mail_details = core.get_email_details(r_id)
                                        full_raw_html = mail_details.get("body", "")
                                        if full_raw_html:
                                            qa_personas = core.get_qa_personas()
                                            for desc, uid in qa_personas.items():
                                                print(f" [WORKER] Rendering email for {desc} ({uid})...", flush=True)
                                                send_event({'type': 'progress', 'percent': 60, 'msg': f'📸 Rendering layout screenshot for persona: {desc}...'})
                                                pers_html = core.get_personalized_email_preview(full_raw_html, uid)
                                                b64_img = core.render_email_to_base64(pers_html) if pers_html else None
                                                if b64_img:
                                                    email_previews.append({"desc": desc, "uid": uid, "b64": b64_img})
                                            rendered_emails_cache[r_id] = email_previews
                                
                                elif n_type == "Push" and r_id:
                                    ext_details = core.get_push_details(r_id)
                                    if ext_details:
                                        title_text = ext_details.get("title", title_text)
                                        body_text = ext_details.get("body", body_text)
                                
                                elif n_type == "Pop-up" and r_id:
                                    ext_details = core.get_inapp_details(r_id)
                                    if ext_details:
                                        title_text = ext_details.get("title", title_text)
                                        body_text = ext_details.get("sub_title", body_text)
                                
                                elif n_type == "SMS" and r_id:
                                    res_details = core.get_sms_details(r_id)
                                    if res_details:
                                        body_text = res_details.get("body", body_text)

                                all_other_labels.update(re.findall(r'\{\{label\.[^\}]+\}\}', f"{title_text} {body_text} {link_text} {subj_text}"))
                                
                                report_data["deep_analysis"].append({
                                    "type": actual_type, "name": n_name, "title_url": title_text, "body": body_text,
                                    "link": link_text, "resource_name": r_name, "subject": subj_text,
                                    "status_name": "Active", "email_url": f"https://{drive_host}/{brand_id}#/{n_type.lower()}/{r_id}" if r_id else "#",
                                    "syntax_errors": core.validate_label_syntax(f"{title_text} {body_text}", ignore_formatting_tags=True),
                                    "previews": email_previews
                                })
                                
                    print(f" [WORKER] Deep searching and resolved for {len(all_other_labels)} smartico macros...", flush=True)
                    send_event({'type': 'progress', 'percent': 85, 'msg': f'🔍 Deep searching {len(all_other_labels)} found macros across database...'})
                    
                    labels_store = {}
                    for lbl in all_other_labels:
                        if not core.is_ignored_label(lbl):
                            norm_name = core.normalize_label_name(lbl)
                            lbl_data = core.get_label_data_with_variations(norm_name)
                            if lbl_data:
                                labels_store[lbl] = lbl_data
                    report_data["labels_data"] = labels_store
                    
                    print(" [WORKER] Generating HTML payload...", flush=True)
                    send_event({'type': 'progress', 'percent': 95, 'msg': f'✨ Compiling interactive HTML matrix report...'})
                    single_campaign_report = core.generate_html_report(report_data)
                    
                    combined_html += f'''
                    <div style="border: 4px solid #cbd5e1; border-top: 8px solid #3b82f6; border-radius: 12px; margin-bottom: 40px; background: white; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                        <div style="background: #f1f5f9; padding: 15px 20px; border-bottom: 1px solid #cbd5e1;">
                            <h2 style="margin: 0; color: #0f172a; font-size: 20px;">📌 Campaign ID #{camp_id}</h2>
                            <a href="{current_url}" target="_blank" style="color: #3b82f6; font-size: 13px;">{current_url}</a>
                        </div>
                        <div style="padding: 20px;">
                            {single_campaign_report}
                        </div>
                    </div>
                    '''
                    
                combined_html += '</div>'
                browser.close()
                
                report_id = f"rep_{uuid4().hex[:12]}"
                REPORTS_CACHE[report_id] = combined_html
                print(f" [WORKER] Saved heavy report to cache slot ID: {report_id}", flush=True)
                send_event({'type': 'done', 'report_id': report_id})
                print(" [WORKER] Pipeline execution completed successfully.", flush=True)

        except Exception as e:
            print(f" [CRITICAL WORKER ERROR] {str(e)}", flush=True)
            send_event({'type': 'error', 'msg': str(e)})
        finally:
            asyncio.run_coroutine_threadsafe(queue.put(None), loop)

    threading.Thread(target=sync_playwright_worker, daemon=True).start()

    async def async_event_generator():
        while True:
            try:
                # 🚨 NETWORK FIX: Emit empty comment pings every 15 seconds so cloud proxies don't drop the connection
                data = await asyncio.wait_for(queue.get(), timeout=15.0)
                if data is None:
                    break
                yield data
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"

    return StreamingResponse(async_event_generator(), media_type="text/event-stream")

@app.get("/audit/download/{report_id}")
def audit_download(report_id: str):
    """
    Serves compiled HTML report payloads securely over standard HTTP protocol.
    """
    html_content = REPORTS_CACHE.get(report_id)
    if not html_content:
        raise HTTPException(status_code=404, detail="Requested report token expired or missing from cache storage")
    return HTMLResponse(content=html_content)

@app.post("/brands/search-campaigns")
def brands_search_campaigns(request: BrandSearchRequest):
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        
        for url in request.urls:
            brand_match = re.search(r"smartico\.ai/(\d+)", url)
            camp_match = re.search(r"(?:scheduled|head)/(\d+)", url)
            if not brand_match or not camp_match:
                continue
                
            brand_id = brand_match.group(1)
            camp_id = camp_match.group(1)
            
            env_match = re.search(r"drive(?:-(\d+))?\.smartico\.ai", url)
            env_suffix = env_match.group(1) if env_match and env_match.group(1) else ""
            boapi_host = f"boapi{env_suffix}.smartico.ai" if env_suffix else "boapi.smartico.ai"
            drive_host = env_match.group(0) if env_match else "drive.smartico.ai"
            
            core = SmarticoCore(context, request.token, brand_id, boapi_host, drive_host)
            meta = core.get_campaign_metadata(camp_id, url)
            
            if isinstance(meta, tuple):
                meta = meta[0]
                
            if meta and isinstance(meta, dict):
                matches = search_keyword_in_dict(meta, request.keyword)
                results.append({
                    "campaign_id": camp_id,
                    "url": url,
                    "name": meta.get("audience_name", meta.get("name", "Unnamed Campaign")),
                    "matches": matches
                })
        browser.close()
    return {"status": "success", "results": results}

@app.post("/brands/bulk-labels")
def brands_bulk_labels(request: BulkLabelsRequest):
    results = {}
    target_condition = request.keyword.lower()
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        core = SmarticoCore(context, request.token, request.brand_id, request.boapi_host, "drive.smartico.ai")
        
        for raw_name in request.labels:
            search_target = core.normalize_label_name(raw_name)
            if not search_target:
                continue
                
            lbl_data = core.get_label_data_with_variations(search_target)
            if not lbl_data:
                results[raw_name] = "❌ Label missing from Smartico database"
                continue
                
            matched_value = None
            if target_condition in str(lbl_data.get("default", "")).lower():
                matched_value = lbl_data.get("default")
                
            for v in lbl_data.get("variations", []):
                cond = str(v.get("conditions_readable", "")).lower()
                if target_condition in cond:
                    matched_value = v.get("tag_value", "")
                    break
                    
            if matched_value is not None:
                results[raw_name] = matched_value
            else:
                results[raw_name] = lbl_data.get("default", "") + " (Fallback: Default Value)"
                
        browser.close()
    return {"status": "success", "results": results}

@app.post("/brands/resolve-links")
def brands_resolve_links(request: ResolveLinksRequest):
    resolved = {}
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    
    for url in request.links:
        url_clean = url.strip()
        if not url_clean:
            continue
        if "." not in url_clean:
            resolved[url] = "⚠️ Invalid URL architecture structure"
            continue
            
        target = url_clean if url_clean.startswith("http") else f"https://{url_clean}"
        try:
            res = requests.get(target, allow_redirects=True, headers=headers, timeout=10, stream=True)
            resolved[url] = res.url
        except Exception as e:
            resolved[url] = f"❌ Connection timeout/handshake failure: {str(e)}"
            
    return {"status": "success", "resolved": resolved}