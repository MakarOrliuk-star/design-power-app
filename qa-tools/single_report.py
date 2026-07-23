import os
import json
import re
import time
import threading
import requests
from datetime import datetime
from dotenv import load_dotenv

import asyncio
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional

from playwright.sync_api import sync_playwright
from core import GeneralCore

# 1. ЗАГРУЖАЕМ ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ
load_dotenv()
SYSTEM_DOMAIN = os.getenv("SYSTEM_DOMAIN")

if not SYSTEM_DOMAIN:
    raise RuntimeError("❌ Критическая ошибка: переменная SYSTEM_DOMAIN не найдена в файле .env!")

# 2. ГЛОБАЛЬНЫЕ СОСТОЯНИЯ И БЛОКИРОВКИ (Замена st.cache_resource)
global_lock = threading.Semaphore(4)
global_state = {
    "online_users": {},
    "audit_logs": []   
}

# 3. ИНИЦИАЛИЗАЦИЯ РОУТЕРА FASTAPI
router = APIRouter(tags=["Single Report"])

# =====================================================================
# 📦 PYDANTIC СХЕМЫ (Входящие данные и ответы)
# =====================================================================
class SingleReportRequest(BaseModel):
    main_url: Optional[str] = None
    pop_url: Optional[str] = None
    token: str
    template_choice: Optional[str] = "Без сверки"
    raw_table_data: Optional[str] = ""

class SingleReportResponse(BaseModel):
    filename: str
    html_content: str

# =====================================================================
# 🧠 БИЗНЕС-ЛОГИКА (Без изменений, кроме замены st.stop на HTTPException)
# =====================================================================
def test_general_info(MAIN_URL, POP_URL, auth_token, expected_data=None, progress_cb=None):
    step_timer = [time.time()]

    def log(msg, percent):
        now = time.time()
        elapsed = now - step_timer[0]
        step_timer[0] = now 
        if progress_cb: progress_cb(msg, percent)

    log("🔌 Подключение к серверам...", 2)
    base_url = MAIN_URL if MAIN_URL else POP_URL

    system_domain = os.getenv("SYSTEM_DOMAIN")

    if "drive-7" in base_url:
        DRIVE_HOST = f"drive-7.{system_domain}"
        BOAPI_HOST = f"boapi7.{system_domain}"
    elif "drive-5" in base_url:
        DRIVE_HOST = f"drive-5.{system_domain}"
        BOAPI_HOST = f"boapi5.{system_domain}"
    else:
        DRIVE_HOST = f"drive.{system_domain}"
        BOAPI_HOST = f"boapi.{system_domain}"

    # 🔐 ЖЕСТКИЙ СТРАЖ АВТОРИЗАЦИИ (Тройной фильтр)
    token_invalid = False
    error_reason = ""

    try:
        ping_check = requests.get(f"https://{BOAPI_HOST}/api/users/me", headers={"authorization": auth_token}, timeout=5)
        
        if not ping_check.ok and ping_check.status_code != 291:
            token_invalid = True
            error_reason = f"HTTP {ping_check.status_code}"
        else:
            try:
                resp_json = ping_check.json()
                if isinstance(resp_json, dict) and str(resp_json.get("status", "")).lower() in ["error", "unauthorized"]:
                    token_invalid = True
                    error_reason = "JSON Error (Unauthorized)"
            except Exception:
                token_invalid = True
                error_reason = "HTML/Cloudflare Redirect"
                
    except requests.exceptions.RequestException as e:
        log(f"⚠️ Предупреждение сети: не удалось проверить токен ({e})", 2)

    if token_invalid:
        log(f"❌ КРИТИЧЕСКАЯ ОШИБКА: Токен недействителен! ({error_reason})", 0)
        # ЗАМЕНА СТРИМЛИТА НА ВЫБРОС ОШИБКИ FASTAPI
        raise HTTPException(status_code=401, detail=f"Ошибка авторизации ({error_reason})! Ваш токен невалидный.")

    report_data = {
        "general_main": {}, "general_pop": {},
        "segment_main": {}, "segment_pop": {},
        "context_status_main": None,
        "context_status_pop": None,
        "settings_registry": [], "mc_registry": [], "condition_registry": [],
        "wait_registry": [], "deep_analysis": [], "labels_data": {},
        "brand_id": "", "flow_links": [],
        "expected_data": expected_data
    }
    
    all_nodes = []
    all_flow_links = []
    rendered_emails_cache = {}

    log("🌐 Запуск виртуального браузера...", 5)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(
            user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
            viewport={"width": 414, "height": 896},
            bypass_csp=True
        )
        
        for target_url in [MAIN_URL, POP_URL]:
            if not target_url: continue
            
            domain = os.getenv("SYSTEM_DOMAIN")
            brand_match = re.search(rf"{re.escape(domain)}/(\d+)", target_url)
            camp_match = re.search(r"(?:scheduled|head)/(\d+)", target_url)
            if not brand_match or not camp_match: continue
                
            brand_id = brand_match.group(1)
            camp_id = camp_match.group(1)
            report_data["brand_id"] = brand_id
            
            api = GeneralCore(context, auth_token, brand_id, BOAPI_HOST, DRIVE_HOST)
            
            log("🕵️‍♂️ Загрузка тестовых профилей...", 8)
            qa_personas = api.get_qa_personas()
            
            if not qa_personas:
                log("⚠️ Внимание: список тестовых профилей пуст (проверьте настройки окружения).", 9)
            else:
                log(f"✅ Готово. Профилей для тестов: {len(qa_personas)}", 9)
                
            log(f"📋 Запрашиваем метаданные кампании #{camp_id}...", 10)
            gen, seg = api.get_campaign_metadata(camp_id, target_url)
            
            if not gen:
                log(f"❌ ОШИБКА ДОСТУПА к кампании {camp_id}", 0)
                continue
                
            if "head" in target_url:
                report_data["general_pop"], report_data["segment_pop"] = gen, seg
            else:
                report_data["general_main"], report_data["segment_main"] = gen, seg
                
            log(f"🔎 Проверяем Context для кампании #{camp_id}...", 15)
            tag_status = api.check_context_campaign_tag(camp_id, target_url)
            
            if "head" in target_url:
                report_data["context_status_pop"] = tag_status
            else:
                report_data["context_status_main"] = tag_status
                
            log(f"🗺️ Генерация интерактивной карты (Flow Map)...", 20)
            f_nodes, f_trans, audit_period = api.get_flow_data_live(camp_id, log)
            
            if "interactive_flow" not in report_data:
                report_data["interactive_flow"] = []
                
            camp_label = "🗺️ Journey (Поп-ап)" if "head" in target_url else "📅 Scheduled (Основная)"
            map_title = f"<div style='margin: 15px 20px -5px 20px; font-weight: bold; color: #334155; font-size: 15px; text-transform: uppercase;'>{camp_label} (ID: {camp_id})</div>"
            
            report_data["interactive_flow"].append(map_title + api.build_flow_html(f_nodes, f_trans))
            report_data["audit_period"] = audit_period

            log(f"🧠 Анализ структуры Flow Builder #{camp_id}...", 25)
            nodes = api.get_campaign_nodes(camp_id)
            all_nodes.extend(nodes)
            
            log(f"🔗 Извлекаем связи между нодами #{camp_id}...", 35)
            transitions_data = api.get_campaign_transitions(camp_id)
            
            if not isinstance(transitions_data, list):
                transitions_data = []
                
            nodes_by_id = {str(n["id"]): n for n in nodes if isinstance(n, dict) and "id" in n}
            
            for aud in transitions_data:
                if not isinstance(aud, dict):
                    continue
                    
                source_id = str(aud.get("enabled_by_activity_id", ""))
                target_audience_id = str(aud.get("id", ""))
                if not source_id or source_id == "None": continue
                
                target_node = next((n for n in nodes if isinstance(n, dict) and str(n.get("audience_id", "")) == target_audience_id), None)
                source_node = nodes_by_id.get(source_id)
                
                if source_node and target_node:
                    t_val = ""
                    
                    raw_conds = aud.get("conditions", [])
                    if isinstance(raw_conds, dict):
                        raw_conds = [raw_conds]
                    elif not isinstance(raw_conds, list):
                        raw_conds = []
                        
                    for c in raw_conds:
                        if isinstance(c, dict) and c.get("p") == "event.action":
                            t_val = str(c.get("v", "")).strip("'\"")
                            break
                            
                    if not t_val:
                        t_val = aud.get("event_type_name", "Next Step").replace("System: ", "").replace("Core: ", "")
                    
                    target_name = target_node.get("name", "Unknown")
                    try: t_type_int = int(target_node.get("type_id"))
                    except: t_type_int = 0
                    
                    target_url_flow = ""
                    res_name = ""
                    details_str = json.dumps(target_node.get("details", {}))
                    res_id_match = re.search(r'"resource_id":\s*(\d+)', details_str)
                    res_id = res_id_match.group(1) if res_id_match else None
                    
                    res_name_match = re.search(r'"resource_name":\s*"([^"]+)"', details_str)
                    if res_name_match: res_name = res_name_match.group(1)
                    
                    is_pwa = t_type_int == 40 and ("pwa" in target_name.lower() or "pwa" in res_name.lower() or "pwa" in t_val.lower())
                        
                    if res_id:
                        if t_type_int == 50: target_url_flow = f"https://{DRIVE_HOST}/{brand_id}#/templated_mail/{res_id}"
                        elif t_type_int == 40: target_url_flow = f"https://{DRIVE_HOST}/{brand_id}#/resource_push/{res_id}"
                        elif t_type_int == 60: target_url_flow = f"https://{DRIVE_HOST}/{brand_id}#/resource_sms/{res_id}"
                        elif t_type_int == 30: target_url_flow = f"https://{DRIVE_HOST}/{brand_id}#/templated_popup/{res_id}"

                    all_flow_links.append({
                        "source": source_node["name"],
                        "target": target_name,
                        "target_url": target_url_flow,
                        "is_pwa": is_pwa,
                        "label": t_val
                    })
        
        # ЗАЩИТА ОТ ФАНТОМНОГО УСПЕХА
        if not report_data.get("general_main") and not report_data.get("general_pop"):
            log("<span style='color: #ef4444;'>❌ ОШИБКА: Токен недействителен или нет доступа к кампании!</span>", 0)
            # ЗАМЕНА СТРИМЛИТА НА ВЫБРОС ОШИБКИ FASTAPI
            raise HTTPException(status_code=403, detail="Ошибка авторизации! Токен недействителен или нет доступа к кампании.")

        report_data["flow_links"] = all_flow_links

        TARGET_NODES = {
            50: "Email", 40: "Push", 60: "SMS", 
            30: "Pop-up", 31: "Inbox",
            203: "Multi-Check", 200: "WebHook", 9: "Wait For",
            201: "Condition Check"
        }
        
        all_campaign_labels = set()
        broken_tag_ids = set()

        log("📸 Извлечение контента узлов...", 45)

        for idx, node in enumerate(all_nodes):
            if not isinstance(node, dict): continue
            type_id = node.get("type_id")
            if type_id not in TARGET_NODES:
                continue
                
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
                    
                    if (not cond_str or cond_str == "Not set" or cond_str == "Пусто" or cond_str == "Значения удалены") and raw_conds:
                        translated = api.resolve_conditions_async(raw_conds)
                        if translated: cond_str = translated
                    
                    if cond_str and "()" in cond_str and raw_conds:
                        cond_str = api.fix_empty_brackets_locally(cond_str, raw_conds)
                        
                    branches.append({"name": branch_name, "condition": cond_str})
                
                report_data["mc_registry"].append({
                    "name": name,
                    "branches": branches
                })
            
            elif node_type == "Condition Check":
                rule = details.get("rule", {})
                cond_str = rule.get("conditions_readable", "")
                raw_conds = rule.get("conditions", [])
                
                if not cond_str and "conditions_n_readable" in details:
                    c_dict = details["conditions_n_readable"]
                    cond_str = c_dict.get("conditions_readable", "")
                    raw_conds = c_dict.get("conditions", [])
                    
                if (not cond_str or cond_str == "Not set" or cond_str == "Пусто" or cond_str == "Значения удалены") and raw_conds:
                    translated = api.resolve_conditions_async(raw_conds)
                    if translated: cond_str = translated
                    
                if cond_str and "()" in cond_str and raw_conds:
                    cond_str = api.fix_empty_brackets_locally(cond_str, raw_conds)
                    
                report_data["condition_registry"].append({
                    "name": name,
                    "condition": cond_str
                })

            elif node_type == "Wait For":
                event_name = details.get("event_type_uiname") or details.get("event_type_name", "Unknown Event")
                timeout_ms = details.get("timeout", 0)
                if timeout_ms >= 86400000: timeout_str = f"{timeout_ms // 86400000} дней"
                elif timeout_ms >= 3600000: timeout_str = f"{timeout_ms // 3600000} часов"
                else: timeout_str = f"{timeout_ms // 60000} минут"
                
                rule = details.get("rule") or {}
                cond_str = rule.get("conditions_readable", "")
                raw_conds = rule.get("conditions", [])
                
                if not cond_str or cond_str.lower() in ["all users", "not set", "пусто", "значения удалены"]:
                    cond_str = ""
                    
                if not cond_str and raw_conds:
                    translated = api.resolve_conditions_async(raw_conds)
                    if translated: cond_str = translated
                    
                if cond_str and "()" in cond_str and raw_conds:
                    cond_str = api.fix_empty_brackets_locally(cond_str, raw_conds)
                    
                report_data["wait_registry"].append({
                    "name": name,
                    "event_name": event_name,
                    "timeout": timeout_str,
                    "condition": cond_str
                })

            elif node_type in ["Email", "Push", "SMS", "Pop-up", "Inbox"]: 
                resources = details.get("resources", [])
                
                caps_map = {1: "Respect user and global caps", 2: "Ignore user and global caps", 3: "Respect user caps, ignore global", 4: "Respect global caps, ignore user"}
                caps = caps_map.get(details.get("caps_impact"), f"ID: {details.get('caps_impact')}")

                timeout_str = "N/A"
                if node_type == "Pop-up":
                    timeout_ms = details.get("delivery_timeout_ms", 0)
                    if timeout_ms > 0:
                        t_mins = timeout_ms // 60000
                        if t_mins >= 1440 and t_mins % 1440 == 0:
                            timeout_str = f"{t_mins // 1440} days"
                        elif t_mins >= 60 and t_mins % 60 == 0:
                            timeout_str = f"{t_mins // 60} hours"
                        elif t_mins >= 60:
                            h = t_mins // 60
                            m = t_mins % 60
                            timeout_str = f"{h}h {m}m"
                        else:
                            timeout_str = f"{t_mins} minutes"
                    else:
                        timeout_str = "N/A"

                period_map = {1: "Send only in activity period", 2: "Send always, disregarding activity period", 3: "Send if possible and if not - in next available activity period", 4: "Send in specific hour (User TZ)", 5: "Send in specific hour (UTC)", 260: "BEST TIME: Deposit+SB+CASINO Bet", 261: "BEST TIME: Online", 262: "BEST TIME: Clicks"}
                
                sys_name = os.getenv("SYSTEM_NAME")
                optout_map = {
                    1: f"Respect Platform and {sys_name} opt-out flags", 
                    2: f"Ignore Platform, opt-out flags, but respect {sys_name}", 
                    3: f"Ignore {sys_name} opt-out flags, but respect Platform", 
                    4: f"Ignore platform and {sys_name} opt-out flags"
                }
                
                optout = optout_map.get(details.get("optout_impact"), f"ID: {details.get('optout_impact')}")
                period = details.get("period")
                period_str = period_map.get(period, f"ID: {period}")

                time_str = ""
                time_norm_str = ""
                if period == 1:
                    a_from = str(details.get("activity_from_time", "00:00"))
                    a_to = str(details.get("activity_to_time", "23:59"))
                    tz = "in user timezone" if details.get("use_user_tz", True) else "in UTC"
                    time_str = f"From {a_from} till {a_to} {tz}"
                    norm_from = a_from.replace("23:59", "00:00")
                    norm_to = a_to.replace("23:59", "00:00")
                    time_norm_str = f"From {norm_from} till {norm_to} {tz}"
                elif period in [4, 5]:
                    time_str = f"From {details.get('time_to_send', 'N/A')}"
                    time_norm_str = time_str
                
                full_period_display = f"{period_str}. {time_str}".strip() if time_str else period_str
                full_period_norm = f"{period_str}. {time_norm_str}".strip() if time_norm_str else period_str

                report_data["settings_registry"].append({
                    "name": name,
                    "type": node_type,
                    "optout": optout,
                    "caps": caps,
                    "period_display": full_period_display,
                    "period_norm": full_period_norm,
                    "delivery_timeout": timeout_str
                })

                res = resources[0] if resources else details
                content = res.get("resource_content", {}) if resources else details
                
                if res or details:
                    body_text, title_text, link_text, res_url = "", "", "", ""
                    resource_name = res.get("resource_name") or details.get("resource_name", "")
                    res_id = res.get("id") or res.get("resource_id") or details.get("resource_id", "")
                    subject_text, status_name, icon_url, image_url, button1 = "", "", "", "", ""
                    
                    actual_type = node_type
                    if node_type == "Push" and ("pwa" in name.lower() or "pwa" in resource_name.lower()):
                        actual_type = "Push PWA"

                    email_previews = []
                    
                    if node_type == "Push":
                        title_text = content.get('title', '')
                        body_text = content.get('body', '')
                        link_text = content.get('action', '')
                        icon_url = content.get('iconUrl', '')
                        image_url = content.get('imageUrl', '')
                        button1 = content.get('button1', '')
                        
                        if res_id:
                            res_url = f"https://{DRIVE_HOST}/{brand_id}#/resource_push/{res_id}"
                            ext_details = api.get_push_details(res_id)
                            if ext_details:
                                resource_name = ext_details.get("resource_name") or ext_details.get("name") or resource_name
                                s_id = ext_details.get("status_id")
                                status_map = {1: "Draft", 2: "Active", 3: "Paused", 6: "Archived"}
                                status_name = ext_details.get("status_name") or status_map.get(s_id, f"ID: {s_id}" if s_id else "N/A")
                                title_text = ext_details.get("title", title_text)
                                body_text = ext_details.get("body", body_text)
                                link_text = ext_details.get("action", link_text)
                                icon_url = ext_details.get("iconUrl", icon_url)
                                image_url = ext_details.get("imageUrl", image_url)
                                button1 = ext_details.get("button1", button1)

                    elif node_type == "Pop-up":
                        title_text = content.get('title', '')
                        body_text = content.get('sub_title', '')
                        image_url = content.get('image_url', '')
                        button1 = content.get('button_text', '')
                        link_text = content.get('button_url', '')
                        
                        if res_id:
                            res_url = f"https://{DRIVE_HOST}/{brand_id}#/templated_popup/{res_id}"
                            ext_details = api.get_inapp_details(res_id)
                            if ext_details:
                                resource_name = ext_details.get("resource_name") or ext_details.get("name") or resource_name
                                s_id = ext_details.get("status_id")
                                status_map = {1: "Draft", 2: "Active", 3: "Paused", 6: "Archived"}
                                status_name = ext_details.get("status_name") or status_map.get(s_id, f"ID: {s_id}" if s_id else "N/A")
                                title_text = ext_details.get("title", title_text)
                                body_text = ext_details.get("sub_title", body_text)
                                image_url = ext_details.get("image_url", image_url)
                                button1 = ext_details.get("button_text", button1)
                                link_text = ext_details.get("button_url", link_text)
                                
                    elif node_type == "Inbox":
                        title_text = content.get('title', '')
                        body_text = content.get('body', '')
                        image_url = content.get('image', '')
                        button1 = content.get('inbox_cta_text_primary', '') or content.get('inbox_cta_text', '')
                        link_text = content.get('action_primary', '') or content.get('action', '')
                        
                        if res_id:
                            res_url = f"https://{DRIVE_HOST}/{brand_id}#/resource_inbox/{res_id}"
                            ext_details = api.get_inbox_details(res_id)
                            if ext_details:
                                resource_name = ext_details.get("resource_name") or ext_details.get("name") or resource_name
                                s_id = ext_details.get("status_id")
                                status_map = {1: "Draft", 2: "Active", 3: "Paused", 6: "Archived"}
                                status_name = ext_details.get("status_name") or status_map.get(s_id, f"ID: {s_id}" if s_id else "N/A")
                                title_text = ext_details.get("title", title_text)
                                body_text = ext_details.get("body", body_text)
                                image_url = ext_details.get("image", image_url)
                                button1 = ext_details.get("inbox_cta_text_primary", button1)
                                link_text = ext_details.get("action_primary", link_text)

                    elif node_type in ["SMS", "Email"]:
                        body_text = content.get('body', '') if node_type == "SMS" else res.get("body", "")
                        resource_name = res.get("resource_name", resource_name)
                        
                        if res_id:
                            res_url = f"https://{DRIVE_HOST}/{brand_id}#/resource_sms/{res_id}" if node_type == "SMS" else f"https://{DRIVE_HOST}/{brand_id}#/templated_mail/{res_id}"
                            res_details = api.get_sms_details(res_id) if node_type == "SMS" else api.get_email_details(res_id)
                            if res_details:
                                resource_name = res_details.get("resource_name") or res_details.get("name") or resource_name
                                subject_text = res_details.get("subject", "")
                                s_id = res_details.get("status_id")
                                status_map = {1: "Draft", 2: "Active", 3: "Paused", 6: "Archived"}
                                status_name = res_details.get("status_name") or status_map.get(s_id, f"ID: {s_id}" if s_id else "N/A")
                                body_text = res_details.get("body", body_text)
                                
                        if node_type == "Email":
                            mail_id_match = re.search(r'templated_mail/(\d+)', res_url)
                            if mail_id_match:
                                m_id = mail_id_match.group(1)
                                if m_id in rendered_emails_cache:
                                    if progress_cb: progress_cb(f"♻️ Скриншоты письма #{m_id} из кэша...", 50)
                                    email_previews = rendered_emails_cache[m_id]
                                else:
                                    if progress_cb: progress_cb(f"📸 Рендерим письмо #{m_id}...", 50)
                                    mail_details = api.get_email_details(m_id)
                                    full_raw_html = mail_details.get("body", "")
                                    if full_raw_html:
                                        for desc, uid in qa_personas.items():
                                            if progress_cb: progress_cb(f"👤 Рендерим юзера {desc}...", 55)
                                            pers_html = api.get_personalized_email_preview(full_raw_html, uid)
                                            b64_img = api.render_email_to_base64(pers_html) if pers_html else None
                                            if b64_img:
                                                email_previews.append({"desc": desc, "uid": uid, "b64": b64_img})
                                        rendered_emails_cache[m_id] = email_previews

                    if node_type == "Push" and actual_type != "Push PWA" and "pwa" in resource_name.lower():
                        actual_type = "Push PWA"

                    if actual_type == "Email": text_for_syntax = f"{subject_text} {body_text}"
                    elif actual_type in ["Push", "Push PWA", "Pop-up", "Inbox"]: text_for_syntax = f"{title_text} {body_text} {button1} {link_text} {image_url}"
                    elif actual_type == "SMS": text_for_syntax = body_text
                    else: text_for_syntax = f"{title_text} {body_text} {resource_name} {subject_text} {button1}"

                    report_data["deep_analysis"].append({
                        "type": actual_type,
                        "name": name,
                        "title_url": title_text,
                        "body": body_text,
                        "link": link_text,
                        "resource_name": resource_name,
                        "subject": subject_text,
                        "status_name": status_name,
                        "email_url": res_url,
                        "icon_url": icon_url,
                        "image_url": image_url,
                        "button1": button1,
                        "syntax_errors": api.validate_label_syntax(text_for_syntax, ignore_formatting_tags=True),
                        "previews": email_previews
                    })

            elif node_type == "WebHook":
                url_val = str(details.get("url") or details.get("endpoint") or details.get("webhook_url") or "")
                body_raw = details.get("body") or details.get("payload") or details.get("data")
                
                if "request" in details and isinstance(details["request"], dict):
                    url_val = url_val or str(details["request"].get("url", ""))
                    body_raw = body_raw or details["request"].get("body")
                
                body_val = json.dumps(body_raw, ensure_ascii=False) if isinstance(body_raw, (dict, list)) else str(body_raw or "")
                
                if not url_val and not body_val:
                    body_val = json.dumps(details, ensure_ascii=False)
                    
                report_data["deep_analysis"].append({
                    "type": "WebHook",
                    "name": name,
                    "title_url": url_val,
                    "body": body_val,
                    "link": "",
                    "resource_name": "",
                    "subject": "",
                    "status_name": "Active",
                    "email_url": "",
                    "icon_url": "",
                    "image_url": "",
                    "button1": "",
                    "syntax_errors": api.validate_label_syntax(f"{url_val} {body_val}", ignore_formatting_tags=True),
                    "previews": []
                })

        all_sms_labels = set()
        all_other_labels = set()
        
        for item in report_data["deep_analysis"]:
            if item.get('type') == 'Email':
                b_val = str(item.get('body', '')) + " " + str(item.get('subject', ''))
                all_other_labels.update(re.findall(r'\{\{label\.[^\}]+\}\}', b_val))
            elif item.get('type') == 'SMS':
                all_sms_labels.update(re.findall(r'\{\{label\.[^\}]+\}\}', str(item.get('body', ''))))
            else:
                combined_text = f"{item.get('title_url', '')} {item.get('body', '')} {item.get('link', '')} {item.get('subject', '')} {item.get('icon_url', '')} {item.get('image_url', '')} {item.get('button1', '')}"
                all_other_labels.update(re.findall(r'\{\{label\.[^\}]+\}\}', combined_text))

        labels_to_fetch = {}
        
        for l in all_other_labels:
            if not api.is_ignored_label(l):
                labels_to_fetch[l] = max(labels_to_fetch.get(l, 0), 1)
                
        for l in all_sms_labels:
            if not api.is_ignored_label(l):
                labels_to_fetch[l] = max(labels_to_fetch.get(l, 0), 3)
                
        checked_labels = set()
        
        log(f"📚 Начинаем скачивание {len(labels_to_fetch)} макросов (до 4 уровней вложенности)...", 70)
        
        while labels_to_fetch:
            lbl, current_depth = labels_to_fetch.popitem()
            
            if lbl in checked_labels:
                continue
            checked_labels.add(lbl)
            
            clean_name = lbl.replace("{{label.", "").replace("}}", "")
            normalized_name = api.normalize_label_name(clean_name)
            
            log(f"🔎 Ищем: {clean_name} (Вложенность: {current_depth})", 75)
            
            audit_data = api.get_label_data_with_variations(normalized_name, log)
            
            if audit_data:
                report_data["labels_data"][lbl] = audit_data
                
                if current_depth > 0:
                    combined_text = str(audit_data.get("default", ""))
                    for v in audit_data.get("variations", []):
                        combined_text += " " + str(v.get("tag_value", ""))
                        
                    nested_raw = set(re.findall(r'\{\{label\.[^\}]+\}\}', combined_text))
                    nested_labels = {l for l in nested_raw if not api.is_ignored_label(l) and l not in checked_labels}
                    
                    if nested_labels:
                        log(f"   🪆 Найдено {len(nested_labels)} вложенных макросов. Кладем в очередь.", 76)
                        
                    for n_lbl in nested_labels:
                        labels_to_fetch[n_lbl] = max(labels_to_fetch.get(n_lbl, 0), current_depth - 1)

        if broken_tag_ids:
            log(f"🔍 Расшифровка {len(broken_tag_ids)} системных имен...", 90)
            resolved_names = api.get_tag_names_by_ids(list(broken_tag_ids))
            
            def deep_replace_id_refs(obj):
                if isinstance(obj, list):
                    for i in obj: deep_replace_id_refs(i)
                elif isinstance(obj, dict):
                    for k, v in list(obj.items()):
                        if isinstance(v, str) and "ID_REF:" in v:
                            def sub_name(match):
                                cid = match.group(1)
                                return resolved_names.get(cid, cid)
                            obj[k] = re.sub(r'ID_REF:(\d+)', sub_name, v)
                        else:
                            deep_replace_id_refs(v)

            deep_replace_id_refs(report_data["mc_registry"])
            deep_replace_id_refs(report_data["condition_registry"])
            deep_replace_id_refs(report_data["wait_registry"])

        log("✨ Сборка HTML отчета...", 95)
        final_html = api.generate_html_report(report_data)
        
        browser.close()
        
        camp_main = report_data.get("general_main", {}).get("Name")
        camp_pop = report_data.get("general_pop", {}).get("Name")
        camp_name = camp_main or camp_pop or "Audit"
        safe_name = "".join([c for c in camp_name if c.isalnum() or c in " -_"]).strip().replace(" ", "_")
        if not safe_name: 
            safe_name = "Audit"
        
        return final_html, safe_name

# =====================================================================
# 🛠️ ПАРСЕРЫ ШАБЛОНОВ (Без изменений)
# =====================================================================
def parse_table_regex(raw_text):
    clean_text = raw_text.replace('"', ' ').replace('\t', '\n\n')
    blocks = re.split(r'\n\s*\n', clean_text)
    
    parsed_offers = []
    
    for block in blocks:
        block = block.strip()
        if not block or len(block) < 10:
            continue
            
        if not re.search(r'min dep', block, re.IGNORECASE):
            continue

        offer_data = {
            "tier_name": "Unknown",
            "currency": None,
            "min_dep": None,
            "wager": None,
            "free_spins": None,
            "match_bonus": None,
            "notes": []
        }

        dep_match = re.search(r'min dep\s+(\d+)\s+([A-Z]{3})', block, re.IGNORECASE)
        if dep_match:
            offer_data["min_dep"] = int(dep_match.group(1))
            offer_data["currency"] = dep_match.group(2).upper()

        wager_match = re.search(r'wager\s*x?(\d+)', block, re.IGNORECASE)
        if wager_match:
            offer_data["wager"] = int(wager_match.group(1))

        fs_match = re.search(r'(\d+)\s*(?:FS|HB FS|Free Spins)', block, re.IGNORECASE)
        if fs_match:
            offer_data["free_spins"] = int(fs_match.group(1))

        match_bonus = re.search(r'(\d+)%\s*up to\s*([\d,]+)', block, re.IGNORECASE)
        if match_bonus:
            offer_data["match_bonus"] = f"{match_bonus.group(1)}% (max {match_bonus.group(2)})"
            
        if re.search(r'Reactivation', block, re.IGNORECASE):
            offer_data["notes"].append("Reactivation 14+ days")

        parsed_offers.append(offer_data)

    if not parsed_offers:
        return {"error": "❌ Не удалось найти условия акции (min dep, wager) в скопированном тексте. Проверьте формат."}

    return {"offers_found": len(parsed_offers), "data": parsed_offers}

def parse_template_dep_bonus(raw_text):
    result = {
        "template_name": "Dep bonus up to 3x times",
        "general_settings": {},
        "offers": []
    }
    
    act_dur = re.search(r'Activation duration\s*-\s*(\d+)', raw_text, re.IGNORECASE)
    dur_hr = re.search(r'Duration hour\s*-\s*(\d+)', raw_text, re.IGNORECASE)
    seg = re.search(r'Сегменты с названием\s*-\s*([^\n\t]+)', raw_text, re.IGNORECASE)
    
    if act_dur: result["general_settings"]["activation_duration_hours"] = int(act_dur.group(1))
    if dur_hr: result["general_settings"]["duration_hours"] = int(dur_hr.group(1))
    if seg: result["general_settings"]["segments"] = seg.group(1).strip()

    date_match = re.search(r'(\d{2}\.\d{2})\s*-\s*(\d{2}\.\d{2})', raw_text)
    if date_match:
        from datetime import datetime
        try:
            start_date = datetime.strptime(date_match.group(1), "%d.%m")
            end_date = datetime.strptime(date_match.group(2), "%d.%m")
            
            if end_date < start_date:
                end_date = end_date.replace(year=start_date.year + 1)
                
            duration_days = (end_date - start_date).days + 1
            
            result["general_settings"]["date_range"] = f"{date_match.group(1)} - {date_match.group(2)}"
            result["general_settings"]["duration_days"] = duration_days
        except Exception:
            pass

    tier_pattern = r'(Tier 3.*?Tier 2.*?\)|Tier 1\s*\(.*?\)|VIP Tier\s*\(.*?\))'
    parts = re.split(tier_pattern, raw_text, flags=re.DOTALL)
    
    if len(parts) > 1:
        for i in range(1, len(parts), 2):
            tier_name = parts[i].replace('\n', ' ').strip()
            tier_content = parts[i+1].replace('\n', ' ')
            
            offer_regex = r'Dep\s+([\d,]+)\s+([A-Z]{3})\s*-\s*get\s+(\d+)%\s*up to\s+([\d,]+)\s*[A-Z]{3}.*?can be used\s+(\d+)\s+times.*?promocode:\s*([A-Z0-9]+).*?Wager\s*x(\d+)'
            matches = re.finditer(offer_regex, tier_content, re.IGNORECASE)
            
            for match in matches:
                result["offers"].append({
                    "tier_name": tier_name,
                    "currency": match.group(2).upper(),
                    "min_dep": int(match.group(1).replace(',', '')),
                    "bonus_percent": int(match.group(3)),
                    "max_bonus": int(match.group(4).replace(',', '')),
                    "usage_limit": int(match.group(5)),
                    "promocode": match.group(6),
                    "wager": int(match.group(7))
                })
                
    if not result["offers"]:
        return {"error": "❌ Не удалось найти офферы по этому шаблону. Проверьте текст."}
        
    return result

def parse_template_deposit_ladder(raw_text):
    result = {
        "template_name": "Deposit bonus ladder",
        "general_settings": {},
        "offers": []
    }
    
    date_match = re.search(r'(\d{2}\.\d{2})\s*-\s*(\d{2}\.\d{2})', raw_text)
    if date_match:
        from datetime import datetime
        try:
            start_date = datetime.strptime(date_match.group(1), "%d.%m")
            end_date = datetime.strptime(date_match.group(2), "%d.%m")
            if end_date < start_date:
                end_date = end_date.replace(year=start_date.year + 1)
            result["general_settings"]["date_range"] = f"{date_match.group(1)} - {date_match.group(2)}"
            result["general_settings"]["duration_days"] = (end_date - start_date).days + 1
        except Exception:
            pass

    act_dur = re.search(r'Activation duration\s*-\s*(\d+)', raw_text, re.IGNORECASE)
    dur_hr = re.search(r'Duration hour\s*-\s*(\d+)', raw_text, re.IGNORECASE)
    seg = re.search(r'Сегменты с названием\s*-\s*([^\n\t]+)', raw_text, re.IGNORECASE)
    usage = re.search(r'Использовать бонус можно только\s*(\d+)\s*раз', raw_text, re.IGNORECASE)
    
    if act_dur: result["general_settings"]["activation_duration_hours"] = int(act_dur.group(1))
    if dur_hr: result["general_settings"]["duration_hours"] = int(dur_hr.group(1))
    if seg: result["general_settings"]["segments"] = seg.group(1).strip()
    if usage: result["general_settings"]["usage_limit"] = int(usage.group(1))

    tier_pattern = r'(Tier 3.*?Tier 2.*?\)|Tier 1\s*\(.*?\)|VIP Tier\s*\(.*?\))'
    parts = re.split(tier_pattern, raw_text, flags=re.DOTALL)
    
    if len(parts) > 1:
        for i in range(1, len(parts), 2):
            tier_name = parts[i].replace('\n', ' ').strip()
            tier_content = parts[i+1].replace('\n', ' ')
            
            currency_blocks = re.split(r'(Wager\s*x\d+)', tier_content, flags=re.IGNORECASE)
            
            for j in range(0, len(currency_blocks) - 1, 2):
                block_text = currency_blocks[j] + currency_blocks[j+1]
                if not block_text.strip(): continue
                
                promo_match = re.search(r'promocode:\s*([A-Z0-9]+)', block_text, re.IGNORECASE)
                wager_match = re.search(r'Wager\s*x(\d+)', block_text, re.IGNORECASE)
                
                if not promo_match or not wager_match: continue
                
                promocode = promo_match.group(1)
                wager = int(wager_match.group(1))
                
                step_regex = r'min dep\s+([\d,]+)\s+([A-Z]{3})\s*(?:-\s*get\s*|-\s*)?(\d+)%\s*up to\s+([\d,]+)'
                step_matches = list(re.finditer(step_regex, block_text, re.IGNORECASE))
                
                if not step_matches: continue
                
                currency = step_matches[0].group(2).upper()
                
                ladder_steps = []
                for sm in step_matches:
                    ladder_steps.append({
                        "min_dep": int(sm.group(1).replace(',', '')),
                        "bonus_percent": int(sm.group(3)),
                        "max_bonus": int(sm.group(4).replace(',', ''))
                    })
                    
                result["offers"].append({
                    "tier_name": tier_name,
                    "currency": currency,
                    "promocode": promocode,
                    "wager": wager,
                    "ladder_steps": ladder_steps
                })
                
    if not result["offers"]:
        return {"error": "❌ Не удалось найти офферы по шаблону 'Deposit bonus ladder'."}
        
    return result

# =====================================================================
# 🚀 ЭНДПОИНТ API (Streaming SSE)
# =====================================================================
@router.post("/generate")
async def generate_single_report_stream(request: SingleReportRequest):
    """
    Запускает одиночный аудит кампании в фоновом потоке.
    Возвращает SSE (Server-Sent Events) поток с логами прогресса.
    Последним сообщением отдаёт готовый HTML напрямую без сохранения в кэш сервера.
    """
    if not request.main_url and not request.pop_url:
        raise HTTPException(status_code=400, detail="Необходимо передать хотя бы одну ссылку (main_url или pop_url).")

    expected_data = None 
    queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    # Внутренняя функция, которая будет работать в параллельном потоке ОС
    def sync_worker():
        def stream_logger(msg, percent=None):
            # 1. Формируем событие
            event_data = {"type": "progress", "msg": msg}
            if percent is not None:
                event_data["percent"] = percent
            
            # 2. Пробрасываем его из синхронного потока в асинхронную очередь FastAPI
            asyncio.run_coroutine_threadsafe(
                queue.put(f"data: {json.dumps(event_data)}\n\n"), 
                loop
            )
            # Оставляем вывод в консоль для дебага
            print(f"➜ [{percent if percent else '*'}] {msg}", flush=True)

        try:
            stream_logger("Добавлен в очередь. Ждем ресурсов сервера...", 2)
            
            with global_lock:
                stream_logger("Ресурсы получены! Запускаю процесс...", 5)
                
                # Запускаем твою оригинальную, нетронутую бизнес-логику
                result = test_general_info(
                    MAIN_URL=request.main_url,
                    POP_URL=request.pop_url,
                    auth_token=request.token,
                    expected_data=expected_data,
                    progress_cb=stream_logger
                )
                
                if result and result[0]:
                    final_report_html, camp_name = result
                    stream_logger("✅ АУДИТ УСПЕШНО ЗАВЕРШЕН!", 100)
                    
                    final_file_name = f"{camp_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.html"
                    
                    # 🔥 ГЛАВНОЕ ОТЛИЧИЕ ОТ КОЛЛЕГИ:
                    # Мы не сохраняем тяжелый HTML в память сервера (REPORTS_CACHE). 
                    # Мы отправляем его прямо в стрим финальным аккордом!
                    done_event = {
                        "type": "done",
                        "filename": final_file_name,
                        "html_content": final_report_html
                    }
                    asyncio.run_coroutine_threadsafe(
                        queue.put(f"data: {json.dumps(done_event)}\n\n"), 
                        loop
                    )
                else:
                    error_event = {"type": "error", "msg": "Скрипт не смог собрать данные."}
                    asyncio.run_coroutine_threadsafe(queue.put(f"data: {json.dumps(error_event)}\n\n"), loop)
                    
        except Exception as e:
            error_event = {"type": "error", "msg": f"Критическая ошибка: {str(e)}"}
            asyncio.run_coroutine_threadsafe(queue.put(f"data: {json.dumps(error_event)}\n\n"), loop)
        finally:
            # Отправляем None, чтобы закрыть стрим
            asyncio.run_coroutine_threadsafe(queue.put(None), loop)

    # 3. Запускаем воркер в отдельном потоке (защита от зависаний)
    threading.Thread(target=sync_worker, daemon=True).start()

    # 4. Генератор, который отправляет события фронтенду
    async def async_event_generator():
        while True:
            try:
                # Ждем события от воркера. Если тишина 15 сек - кидаем пинг
                data = await asyncio.wait_for(queue.get(), timeout=15.0)
                if data is None: 
                    break # Сигнал закрытия потока
                yield data
            except asyncio.TimeoutError:
                # Тот самый анти-таймаут пинг для Railway
                yield ": keepalive\n\n"

    # Возвращаем поток
    return StreamingResponse(async_event_generator(), media_type="text/event-stream")