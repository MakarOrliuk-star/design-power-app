import json
import queue
import asyncio
import threading
import re
import time
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from pydantic import BaseModel
from playwright.sync_api import sync_playwright

from smartico_core_prod import SmarticoCore

app = FastAPI(title="Smartico Auditor Worker")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class AuditRequest(BaseModel):
    main_url: str = ""
    pop_url: str = ""
    token: str
    use_stats: bool = True
    days_back: int = 14

def run_audit_task(main_url: str, pop_url: str, token: str, use_stats: bool, days_back: int, q: queue.Queue):
    """
    Основной воркер. Выполняет полный парсинг кампании и шлет прогресс в очередь.
    """
    step_timer = [time.time()]

    def log_cb(msg, pct):
        now = time.time()
        elapsed = now - step_timer[0]
        step_timer[0] = now
        q.put({"type": "progress", "msg": f"[{elapsed:.1f}s] {msg}", "percent": pct})

    log_cb("🔌 Подключение к серверам...", 2)
    base_url = main_url if main_url else pop_url

    if not base_url:
        q.put({"type": "error", "msg": "Не передана ссылка на кампанию"})
        return

    if "drive-7" in base_url:
        DRIVE_HOST, BOAPI_HOST = "drive-7.smartico.ai", "boapi7.smartico.ai"
    elif "drive-5" in base_url:
        DRIVE_HOST, BOAPI_HOST = "drive-5.smartico.ai", "boapi5.smartico.ai"
    else:
        DRIVE_HOST, BOAPI_HOST = "drive.smartico.ai", "boapi.smartico.ai"

    report_data = {
        "general_main": {}, "general_pop": {},
        "segment_main": {}, "segment_pop": {},
        "context_status_main": None,
        "context_status_pop": None,
        "settings_registry": [], "mc_registry": [], "condition_registry": [],
        "wait_registry": [], "deep_analysis": [], "labels_data": {},
        "brand_id": "", "flow_links": [], "interactive_flow": []
    }
    
    all_nodes = []
    all_flow_links = []
    rendered_emails_cache = {}

    log_cb("🌐 Запуск виртуального браузера...", 5)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True, 
                args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
            )
            context = browser.new_context(
                user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
                viewport={"width": 414, "height": 896},
                bypass_csp=True
            )
            
            for target_url in [main_url, pop_url]:
                if not target_url: continue
                
                brand_match = re.search(r"smartico\.ai/(\d+)", target_url)
                camp_match = re.search(r"(?:scheduled|head)/(\d+)", target_url)
                if not brand_match or not camp_match: continue
                    
                brand_id = brand_match.group(1)
                camp_id = camp_match.group(1)
                report_data["brand_id"] = brand_id
                
                api = SmarticoCore(context, token, brand_id, BOAPI_HOST, DRIVE_HOST)
                
                log_cb("🕵️‍♂️ Получение QA-персон...", 8)
                qa_personas = api.get_qa_personas()
                if not qa_personas:
                    log_cb("⚠️ QA-персоны не найдены, симуляции могут быть пропущены.", 9)
                    
                log_cb(f"📋 Запрашиваем метаданные кампании #{camp_id}...", 10)
                gen, seg = api.get_campaign_metadata(camp_id, target_url)
                if not gen:
                    log_cb(f"❌ ОШИБКА ДОСТУПА к кампании {camp_id} (Токен истек или нет прав)", 0)
                    q.put({"type": "error", "msg": f"Нет доступа к {camp_id}"})
                    return
                    
                if "head" in target_url:
                    report_data["general_pop"], report_data["segment_pop"] = gen, seg
                else:
                    report_data["general_main"], report_data["segment_main"] = gen, seg
                    
                log_cb(f"🔎 Проверяем Context для кампании #{camp_id}...", 15)
                tag_status = api.check_context_campaign_tag(camp_id, target_url)
                if "head" in target_url: report_data["context_status_pop"] = tag_status
                else: report_data["context_status_main"] = tag_status
                    
                log_cb("🗺️ Генерация интерактивной карты (Flow Map)...", 20)
                f_nodes, f_trans, audit_period = api.get_flow_data_live(camp_id, log_cb, use_live_view=use_stats, days_back=days_back)
                
                camp_label = "🗺️ Journey (Поп-ап)" if "head" in target_url else "📅 Scheduled (Основная)"
                map_title = f"<div style='margin: 15px 20px -5px 20px; font-weight: bold; color: #334155; font-size: 15px; text-transform: uppercase;'>{camp_label} (ID: {camp_id})</div>"
                
                report_data["interactive_flow"].append(map_title + api.build_flow_html(f_nodes, f_trans))
                report_data["audit_period"] = audit_period

                log_cb(f"🧠 Анализ структуры Flow Builder #{camp_id}...", 25)
                nodes = api.get_campaign_nodes(camp_id)
                all_nodes.extend(nodes)
                
                log_cb(f"🔗 Извлекаем связи между нодами #{camp_id}...", 35)
                transitions_data = api.get_campaign_transitions(camp_id)
                nodes_by_id = {str(n["id"]): n for n in nodes}
                
                for aud in transitions_data:
                    source_id = str(aud.get("enabled_by_activity_id", ""))
                    target_audience_id = str(aud.get("id", ""))
                    if not source_id or source_id == "None": continue
                    
                    target_node = next((n for n in nodes if str(n.get("audience_id", "")) == target_audience_id), None)
                    source_node = nodes_by_id.get(source_id)
                    
                    if source_node and target_node:
                        t_val = ""
                        for c in aud.get("conditions", []):
                            if c.get("p") == "event.action":
                                t_val = str(c.get("v", "")).strip("'\"")
                                break
                        if not t_val: t_val = aud.get("event_type_name", "Next Step").replace("System: ", "").replace("Core: ", "")
                        
                        target_name = target_node.get("name", "Unknown")
                        try: t_type_int = int(target_node.get("type_id"))
                        except: t_type_int = 0
                        
                        target_url_flow = ""
                        res_name = ""
                        details_str = json.dumps(target_node.get("details", {}))
                        res_id_match = re.search(r'"resource_id":\s*(\d+)', details_str)
                        res_id = res_id_match.group(1) if res_id_match else None
                        
                        if res_id:
                            if t_type_int == 50: target_url_flow = f"https://{DRIVE_HOST}/{brand_id}#/templated_mail/{res_id}"
                            elif t_type_int == 40: target_url_flow = f"https://{DRIVE_HOST}/{brand_id}#/resource_push/{res_id}"
                            elif t_type_int == 60: target_url_flow = f"https://{DRIVE_HOST}/{brand_id}#/resource_sms/{res_id}"
                            elif t_type_int == 30: target_url_flow = f"https://{DRIVE_HOST}/{brand_id}#/templated_popup/{res_id}"

                        is_pwa = t_type_int == 40 and ("pwa" in target_name.lower() or "pwa" in res_name.lower() or "pwa" in t_val.lower())
                        
                        all_flow_links.append({"source": source_node["name"], "target": target_name, "target_url": target_url_flow, "is_pwa": is_pwa, "label": t_val})
                        
            report_data["flow_links"] = all_flow_links

            TARGET_NODES = {
                50: "Email", 40: "Push", 60: "SMS", 30: "Pop-up",
                203: "Multi-Check", 200: "WebHook", 9: "Wait For", 201: "Condition Check"
            }
            
            log_cb("📸 Извлечение контента узлов...", 45)

            for idx, node in enumerate(all_nodes):
                type_id = node.get("type_id")
                if type_id not in TARGET_NODES: continue
                    
                name = node.get("name", "Unknown")
                node_type = TARGET_NODES[type_id]
                details = node.get("details", {})

                if node_type == "Multi-Check":
                    branches = []
                    for check in details.get("user_checks", []):
                        branch_name = check.get("name", "Unknown")
                        c_dict = check.get("conditions_n_readable") or {}
                        cond_str = c_dict.get("conditions_readable", "")
                        raw_conds = c_dict.get("conditions", [])
                        if (not cond_str or cond_str == "Not set" or cond_str == "Пусто") and raw_conds:
                            translated = api.resolve_conditions_async(raw_conds)
                            if translated: cond_str = translated
                        if cond_str and "()" in cond_str and raw_conds:
                            cond_str = api.fix_empty_brackets_locally(cond_str, raw_conds)
                        branches.append({"name": branch_name, "condition": cond_str})
                    report_data["mc_registry"].append({"name": name, "branches": branches})
                
                elif node_type == "Condition Check":
                    rule = details.get("rule", {})
                    cond_str = rule.get("conditions_readable", "")
                    raw_conds = rule.get("conditions", [])
                    if not cond_str and "conditions_n_readable" in details:
                        c_dict = details["conditions_n_readable"]
                        cond_str = c_dict.get("conditions_readable", "")
                        raw_conds = c_dict.get("conditions", [])
                    if (not cond_str or cond_str == "Not set" or cond_str == "Пусто") and raw_conds:
                        translated = api.resolve_conditions_async(raw_conds)
                        if translated: cond_str = translated
                    if cond_str and "()" in cond_str and raw_conds:
                        cond_str = api.fix_empty_brackets_locally(cond_str, raw_conds)
                    report_data["condition_registry"].append({"name": name, "condition": cond_str})

                elif node_type in ["Email", "Push", "SMS", "Pop-up"]:
                    resources = details.get("resources", [])
                    caps = "ID: " + str(details.get("caps_impact"))
                    timeout_str = "N/A"
                    
                    if node_type == "Pop-up":
                        timeout_ms = details.get("delivery_timeout_ms", 0)
                        if timeout_ms > 0: timeout_str = f"{timeout_ms // 60000} minutes"
                        report_data["settings_registry"].append({"name": name, "type": "Pop-up", "caps": caps, "delivery_timeout": timeout_str})

                    if resources:
                        res = resources[0]
                        content = res.get("resource_content", {})
                        
                        body_text, title_text, link_text, res_url = "", "", "", ""
                        resource_name = res.get("resource_name", "")
                        res_id = res.get("id", "") or res.get("resource_id", "")
                        subject_text, status_name, icon_url, image_url, button1 = "", "", "", "", ""
                        
                        actual_type = "Push PWA" if node_type == "Push" and ("pwa" in name.lower() or "pwa" in resource_name.lower()) else node_type
                        email_previews = []
                        
                        if node_type == "Push":
                            title_text, body_text, link_text = content.get('title', ''), content.get('body', ''), content.get('action', '')
                            icon_url, image_url, button1 = content.get('iconUrl', ''), content.get('imageUrl', ''), content.get('button1', '')
                            if res_id:
                                res_url = f"https://{DRIVE_HOST}/{brand_id}#/resource_push/{res_id}"
                                ext_details = api.get_push_details(res_id)
                                if ext_details:
                                    resource_name = ext_details.get("resource_name") or resource_name
                                    title_text, body_text = ext_details.get("title", title_text), ext_details.get("body", body_text)
                                    link_text, button1 = ext_details.get("action", link_text), ext_details.get("button1", button1)

                        elif node_type == "Pop-up":
                            title_text, body_text, link_text = content.get('title', ''), content.get('sub_title', ''), content.get('button_url', '')
                            image_url, button1 = content.get('image_url', ''), content.get('button_text', '')
                            if res_id:
                                res_url = f"https://{DRIVE_HOST}/{brand_id}#/templated_popup/{res_id}"
                                ext_details = api.get_inapp_details(res_id)
                                if ext_details:
                                    resource_name = ext_details.get("resource_name") or resource_name
                                    title_text, body_text = ext_details.get("title", title_text), ext_details.get("sub_title", body_text)
                                    button1, link_text = ext_details.get("button_text", button1), ext_details.get("button_url", link_text)
                                    
                        elif node_type in ["SMS", "Email"]:
                            body_text = content.get('body', '') if node_type == "SMS" else res.get("body", "")
                            if res_id:
                                res_url = f"https://{DRIVE_HOST}/{brand_id}#/resource_sms/{res_id}" if node_type == "SMS" else f"https://{DRIVE_HOST}/{brand_id}#/templated_mail/{res_id}"
                                res_details = api.get_sms_details(res_id) if node_type == "SMS" else api.get_email_details(res_id)
                                if res_details:
                                    resource_name = res_details.get("resource_name") or resource_name
                                    subject_text, body_text = res_details.get("subject", ""), res_details.get("body", body_text)
                                    
                            if node_type == "Email" and res_url:
                                m_id_match = re.search(r'templated_mail/(\d+)', res_url)
                                if m_id_match:
                                    m_id = m_id_match.group(1)
                                    if m_id not in rendered_emails_cache:
                                        log_cb(f"📸 Рендерим письмо #{m_id}...", 50)
                                        mail_details = api.get_email_details(m_id)
                                        full_raw_html = mail_details.get("body", "")
                                        if full_raw_html:
                                            for desc, uid in qa_personas.items():
                                                pers_html = api.get_personalized_email_preview(full_raw_html, uid)
                                                b64_img = api.render_email_to_base64(pers_html) if pers_html else None
                                                if b64_img: email_previews.append({"desc": desc, "uid": uid, "b64": b64_img})
                                            rendered_emails_cache[m_id] = email_previews
                                    else:
                                        email_previews = rendered_emails_cache[m_id]

                        if actual_type == "Email": text_for_syntax = f"{subject_text} {body_text}"
                        elif actual_type in ["Push", "Push PWA", "Pop-up"]: text_for_syntax = f"{title_text} {body_text} {button1} {link_text} {image_url}"
                        elif actual_type == "SMS": text_for_syntax = body_text
                        else: text_for_syntax = f"{title_text} {body_text} {resource_name} {subject_text} {button1}"

                        report_data["deep_analysis"].append({
                            "type": actual_type, "name": name, "title_url": title_text, "body": body_text,
                            "link": link_text, "resource_name": resource_name, "subject": subject_text,
                            "status_name": "Active", "email_url": res_url, "icon_url": icon_url,
                            "image_url": image_url, "button1": button1,
                            "syntax_errors": api.validate_label_syntax(text_for_syntax, ignore_formatting_tags=True),
                            "previews": email_previews
                        })

                elif node_type == "WebHook":
                    url_val = str(details.get("url") or details.get("endpoint") or "")
                    body_raw = details.get("body") or details.get("payload")
                    body_val = json.dumps(body_raw, ensure_ascii=False) if isinstance(body_raw, (dict, list)) else str(body_raw or "")
                    
                    report_data["deep_analysis"].append({
                        "type": "WebHook", "name": name, "title_url": url_val, "body": body_val,
                        "link": "", "resource_name": "", "subject": "", "status_name": "Active",
                        "email_url": "", "icon_url": "", "image_url": "", "button1": "",
                        "syntax_errors": api.validate_label_syntax(f"{url_val} {body_val}", ignore_formatting_tags=True),
                        "previews": []
                    })

            all_other_labels = set()
            for item in report_data["deep_analysis"]:
                comb_text = f"{item.get('title_url','')} {item.get('body','')} {item.get('link','')} {item.get('subject','')}"
                all_other_labels.update(re.findall(r'\{\{label\.[^\}]+\}\}', comb_text))

            labels_to_fetch = {l: 1 for l in all_other_labels if not api.is_ignored_label(l)}
            checked_labels = set()
            
            log_cb(f"📚 Скачивание {len(labels_to_fetch)} макросов...", 70)
            
            while labels_to_fetch:
                lbl, current_depth = labels_to_fetch.popitem()
                if lbl in checked_labels: continue
                checked_labels.add(lbl)
                
                clean_name = lbl.replace("{{label.", "").replace("}}", "")
                normalized_name = api.normalize_label_name(clean_name)
                
                audit_data = api.get_label_data_with_variations(normalized_name, None)
                if audit_data:
                    report_data["labels_data"][lbl] = audit_data

            log_cb("✨ Сборка HTML отчета...", 95)
            final_html = api.generate_html_report(report_data)
            
            browser.close()
            log_cb("✅ Готово!", 100)
            q.put({"type": "done", "html": final_html})

    except Exception as e:
        q.put({"type": "error", "msg": str(e)})


@app.post("/audit/stream")
async def stream_audit(req: AuditRequest):
    q = queue.Queue()
    thread = threading.Thread(
        target=run_audit_task, 
        args=(req.main_url, req.pop_url, req.token, req.use_stats, req.days_back, q)
    )
    thread.start()

    async def event_generator():
        while True:
            item = await asyncio.to_thread(q.get)
            yield {"data": json.dumps(item)}
            if item["type"] in ["done", "error"]:
                break

    return EventSourceResponse(event_generator())