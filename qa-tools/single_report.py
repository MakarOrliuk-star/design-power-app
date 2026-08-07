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
from typing import Optional, List, Dict, Any

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
class AuditTask(BaseModel):
    type: str
    value: str
    env: Optional[str] = "env2"
    brandId: Optional[str] = ""

class SingleReportRequest(BaseModel):
    tasks: List[AuditTask] = []
    token: Optional[str] = ""
    tokens: Dict[str, str] = {}
    template_choice: Optional[str] = "Без сверки"
    raw_table_data: Optional[str] = ""
    mega_type: Optional[str] = "react"
    use_stats: Optional[bool] = False
    days_back: Optional[int] = 14

class SingleReportResponse(BaseModel):
    filename: str
    html_content: str

class PreviewRequest(BaseModel):
    template_choice: str
    raw_table_data: str

class PreviewRequest(BaseModel):
    template_choice: str
    raw_table_data: str
    mega_type: str = "react"

@router.post("/preview")
async def preview_template_data(request: PreviewRequest):
    """Быстрый тест парсера без запуска полного аудита"""
    choice = request.template_choice.lower()
    raw_text = request.raw_table_data
    
    if not raw_text:
        return {"error": "Текст не передан"}
        
    if "dep promo code x3" in choice or "dep promo" in choice:
        return parse_template_dep_promo_x3(raw_text)
    elif "mid month react" in choice or "mid month" in choice:
        return parse_template_mid_month_react(raw_text)
    elif "deposit bonus ladder" in choice or "ступен" in choice:
        return parse_template_deposit_ladder(raw_text)
    elif "bonus ladder" in choice:
        return parse_template_bonus_ladder(raw_text)
    elif "mission" in choice or "мисси" in choice:
        return parse_template_bets_mission(raw_text)
    elif "choose" in choice or "выбор" in choice:
        return parse_template_choose_bonus(raw_text)
    elif "mega" in choice or "react" in choice:
        return parse_template_mega(raw_text, request.mega_type)
    else:
        return {"error": "❌ Шаблон не распознан. Выберите правильный шаблон из списка."}

# =====================================================================
# 🧠 БИЗНЕС-ЛОГИКА (Без изменений, кроме замены st.stop на HTTPException)
# =====================================================================
def test_general_info(tasks, tokens, expected_data=None, progress_cb=None):
    step_timer = [time.time()]

    def log(msg, percent):
        now = time.time()
        elapsed = now - step_timer[0]
        step_timer[0] = now 
        if progress_cb: progress_cb(msg, percent)

    log("🔌 Подключение к серверам...", 2)
    
    # 1. Инициализация по первой валидной ссылке
    base_url = ""
    brand_id = ""
    first_env = "env2"
    
    for t in tasks:
        if "http" in t.value:
            base_url = t.value
            brand_match = re.search(rf'{re.escape(SYSTEM_DOMAIN)}/(\d+)', t.value) or re.search(r'/(\d+)(?:#|/|$)', t.value)
            if brand_match:
                brand_id = brand_match.group(1)
                if "drive-7" in t.value: first_env = "env7"
                elif "drive-5" in t.value: first_env = "env5"
                break
                
    # 🟢 Защита от пустого Brand ID (Требуем только ссылки)
    if not brand_id:
        log("<span style='color: #ef4444;'>❌ ОШИБКА: В конструктор не передано ни одной валидной ссылки! Вставляйте полные ссылки.</span>", 0)
        raise HTTPException(status_code=400, detail="Не найден Brand ID. Используйте полные ссылки.")

    system_domain = SYSTEM_DOMAIN

    if first_env == "env7":
        DRIVE_HOST = f"drive-7.{system_domain}"
        BOAPI_HOST = f"boapi7.{system_domain}"
    elif first_env == "env5":
        DRIVE_HOST = f"drive-5.{system_domain}"
        BOAPI_HOST = f"boapi5.{system_domain}"
    else:
        DRIVE_HOST = f"drive.{system_domain}"
        BOAPI_HOST = f"boapi.{system_domain}"

    auth_token = tokens.get(first_env) or tokens.get("env2", "")

    # 🔐 БЫСТРАЯ ПРОВЕРКА ТОКЕНА ДЛЯ ПЕРВОЙ ССЫЛКИ
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
        raise HTTPException(status_code=401, detail=f"Ошибка авторизации ({error_reason})! Ваш токен невалидный.")

    report_data = {
        "general_main": {}, "general_pop": {},
        "segment_main": {}, "segment_pop": {},
        "context_status_main": None,
        "context_status_pop": None,
        "general_list": [],  # 🟢 ФИКС: Новый список для безлимитного количества кампаний
        "settings_registry": [], "mc_registry": [], "condition_registry": [],
        "wait_registry": [], "deep_analysis": [], "labels_data": {},
        "brand_id": brand_id, "flow_links": [],
        "expected_data": expected_data
    }
    
    all_nodes = []
    all_flow_links = []
    standalone_labels = []
    standalone_labels_with_env = []
    rendered_emails_cache = {}

    log("🌐 Запуск виртуального браузера...", 5)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(
            user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
            viewport={"width": 414, "height": 896},
            bypass_csp=True
        )
        
        api = GeneralCore(context, auth_token, brand_id, BOAPI_HOST, DRIVE_HOST)
        
        log("🕵️‍♂️ Загрузка тестовых профилей...", 8)
        qa_personas = api.get_qa_personas()
        if not qa_personas:
            log("⚠️ Внимание: список тестовых профилей пуст.", 9)
        
        camp_count = 0
        
        # 🔄 Обрабатываем все задачи из Конструктора
        for task in tasks:
            t_type = task.type
            t_val = task.value.strip()
            if not t_val: continue
            
            # 🟢 СТРОГАЯ ПРОВЕРКА: ТОЛЬКО ССЫЛКИ
            if "http" not in t_val:
                log(f"⚠️ Пропущена задача: Ожидалась полная ссылка, получено '{t_val}'", 75)
                continue

            # 🟢 ДИНАМИЧЕСКОЕ ПЕРЕКЛЮЧЕНИЕ ОКРУЖЕНИЯ ДЛЯ КАЖДОЙ ССЫЛКИ НА ЛЕТУ
            b_match = re.search(rf'{re.escape(SYSTEM_DOMAIN)}/(\d+)', t_val) or re.search(r'/(\d+)(?:#|/|$)', t_val)
            if b_match:
                new_brand = b_match.group(1)
                new_env = "env2"
                if "drive-7" in t_val: new_env = "env7"
                elif "drive-5" in t_val: new_env = "env5"
                
                # Достаем токен для этого окружения
                current_token = tokens.get(new_env) or tokens.get("env2", "")
                if not current_token:
                    log(f"❌ ОШИБКА: Нет токена для {new_env.upper()}! Ссылка пропущена.", 0)
                    continue

                # Обновляем API Core
                api.brand_id = new_brand
                api.headers["active_label_id"] = new_brand
                api.headers["authorization"] = current_token
                api.auth_token = current_token
                
                if new_env == "env7":
                    api.boapi_host = f"boapi7.{system_domain}"
                    api.drive_host = f"drive-7.{system_domain}"
                elif new_env == "env5":
                    api.boapi_host = f"boapi5.{system_domain}"
                    api.drive_host = f"drive-5.{system_domain}"
                else:
                    api.boapi_host = f"boapi.{system_domain}"
                    api.drive_host = f"drive.{system_domain}"
                    
                # Обновляем профили для текущего окружения
                qa_personas = api.get_qa_personas()
            
            # --- 1. ЕСЛИ ЭТО КАМПАНИЯ ---
            if t_type == "campaign":
                domain = os.getenv("SYSTEM_DOMAIN")
                camp_match = re.search(r"(?:scheduled|head)/(\d+)", t_val)
                if not camp_match: continue
                    
                camp_id = camp_match.group(1)
                
                log(f"📋 Запрашиваем метаданные кампании #{camp_id}...", 10)
                gen, seg = api.get_campaign_metadata(camp_id, t_val)
                
                if not gen:
                    log(f"❌ ОШИБКА ДОСТУПА к кампании {camp_id}", 0)
                    continue
                    
                is_pop = "head" in t_val or camp_count > 0
                if is_pop:
                    report_data["general_pop"], report_data["segment_pop"] = gen, seg
                    report_data["context_status_pop"] = api.check_context_campaign_tag(camp_id, t_val)
                else:
                    report_data["general_main"], report_data["segment_main"] = gen, seg
                    report_data["context_status_main"] = api.check_context_campaign_tag(camp_id, t_val)
                
                # 🟢 ФИКС: Складываем ВСЕ кампании в общий массив для нового рендера
                report_data["general_list"].append({
                    "is_pop": is_pop,
                    "general": gen,
                    "segment": seg,
                    "context_status": api.check_context_campaign_tag(camp_id, t_val)
                })
                    
                camp_count += 1
                    
                log(f"🗺️ Генерация интерактивной карты (Flow Map)...", 20)
                f_nodes, f_trans, audit_period = api.get_flow_data_live(camp_id, log)
                
                if "interactive_flow" not in report_data:
                    report_data["interactive_flow"] = []
                    
                camp_label = "🗺️ Journey " if is_pop else "📅 Scheduled "
                map_title = f"<div style='margin: 15px 20px -5px 20px; font-weight: bold; color: #334155; font-size: 15px; text-transform: uppercase;'>{camp_label} (ID: {camp_id})</div>"
                
                report_data["interactive_flow"].append(map_title + api.build_flow_html(f_nodes, f_trans))
                report_data["audit_period"] = audit_period

                log(f"🧠 Анализ структуры Flow Builder #{camp_id}...", 25)
                nodes = api.get_campaign_nodes(camp_id)
                # 🟢 ФИКС: Сохраняем исходный URL, чтобы позже менять сервер на лету
                for n in nodes:
                    if isinstance(n, dict): n["_source_url"] = t_val
                all_nodes.extend(nodes)
                
                log(f"🔗 Извлекаем связи между нодами #{camp_id}...", 35)
                transitions_data = api.get_campaign_transitions(camp_id)
                if not isinstance(transitions_data, list): transitions_data = []
                
                nodes_by_id = {str(n["id"]): n for n in nodes if isinstance(n, dict) and "id" in n}
                
                for aud in transitions_data:
                    if not isinstance(aud, dict): continue
                    source_id = str(aud.get("enabled_by_activity_id", ""))
                    target_audience_id = str(aud.get("id", ""))
                    if not source_id or source_id == "None": continue
                    
                    target_node = next((n for n in nodes if isinstance(n, dict) and str(n.get("audience_id", "")) == target_audience_id), None)
                    source_node = nodes_by_id.get(source_id)
                    
                    if source_node and target_node:
                        t_action = ""
                        raw_conds = aud.get("conditions", [])
                        if isinstance(raw_conds, dict): raw_conds = [raw_conds]
                        elif not isinstance(raw_conds, list): raw_conds = []
                        for c in raw_conds:
                            if isinstance(c, dict) and c.get("p") == "event.action":
                                t_action = str(c.get("v", "")).strip("'\"")
                                break
                        if not t_action: t_action = aud.get("event_type_name", "Next Step").replace("System: ", "").replace("Core: ", "")
                        
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
                        
                        is_pwa = t_type_int == 40 and ("pwa" in target_name.lower() or "pwa" in res_name.lower() or "pwa" in t_action.lower())
                            
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
                            "label": t_action
                        })
                        
            # --- 2. ЕСЛИ ЭТО ОДИНОЧНАЯ КОММУНИКАЦИЯ ---
            elif t_type in ["email", "push", "sms", "inbox", "popup"]:
                if "http" not in t_val:
                    log(f"⚠️ Пропущена задача: Ожидалась полная ссылка, получено '{t_val}'", 75)
                    continue
                res_match = re.search(r'/(\d+)/?$', t_val) or re.search(r'/(\d+)(?:#|/|$)', t_val)
                try:
                    res_id = int(res_match.group(1)) if res_match else int(re.sub(r'\D', '', t_val) or 0)
                except: continue
                type_mapping = {"email": 50, "push": 40, "sms": 60, "popup": 30, "inbox": 31}
                # Подбрасываем фейковую ноду в общий котел (ядро проглотит её как родную)
                fake_node = {
                    "id": f"standalone_{res_id}",
                    "name": f"Standalone {t_type.capitalize()} ({res_id})",
                    "type_id": type_mapping.get(t_type, 0),
                    "details": {"resource_id": res_id, "caps_impact": 1, "optout_impact": 1},
                    "_source_url": t_val, # 🟢 Сохраняем URL для динамического переключения сервера
                    "_personas": api.get_qa_personas() # 🟢 ФИКС: Сохраняем профили, актуальные для текущего окружения
                }
                all_nodes.append(fake_node)
                
            # --- 3. ЕСЛИ ЭТО ОТДЕЛЬНЫЙ ЛЕЙБЛ ---
            elif t_type == "label":
                lbl_id_match = re.search(r'labels_tags/(\d+)', t_val)
                if lbl_id_match:
                    try:
                        import requests as safe_req
                        import json as safe_json
                        lbl_id = int(lbl_id_match.group(1))
                        
                        # 🟢 Используем уже обновленные настройки API Core (api.boapi_host, api.brand_id)
                        q_params = {"filter": safe_json.dumps({"id": [lbl_id]}), "lbl": api.brand_id}
                        
                        # 🟢 ФИКС: Увеличиваем таймаут, так как база макросов тяжелая и API может отвечать долго
                        r = safe_req.get(
                            f"https://{api.boapi_host}/api/labels_tags", 
                            params=q_params, 
                            headers=api.headers, 
                            timeout=20
                        )
                        
                        if r.ok:
                            lbl_data = r.json()
                            items = lbl_data.get("result", lbl_data) if isinstance(lbl_data, dict) else lbl_data
                            if isinstance(items, list) and items:
                                item = items[0]
                                if isinstance(item, dict):
                                    fetched_name = item.get("name") or item.get("tag_name") or item.get("key")
                                    if fetched_name:
                                        l_val = fetched_name if fetched_name.startswith('{{label.') else f'{{{{label.{fetched_name}}}}}'
                                        standalone_labels.append(l_val)
                                        standalone_labels_with_env.append({"label": l_val, "url": t_val})
                                    else:
                                        log(f"⚠️ API вернул макрос #{lbl_id}, но поле имени пустое.", 75)
                        else:
                            log(f"⚠️ Ошибка API ({r.status_code}) при поиске макроса #{lbl_id}", 75)
                    except Exception as e:
                        log(f"⚠️ Ошибка извлечения имени макроса по ID #{lbl_id_match.group(1)}: {e}", 75)
                else:
                    log(f"⚠️ Не удалось найти ID макроса в ссылке: {t_val}", 75)
    
        # ЗАЩИТА ОТ ФАНТОМНОГО УСПЕХА
        if not all_nodes and not standalone_labels and not report_data.get("general_list") and not report_data.get("general_main"):
            log("<span style='color: #ef4444;'>❌ ОШИБКА: Нет данных для анализа. Проверьте правильность ссылок!</span>", 0)
            raise HTTPException(status_code=403, detail="Нет данных для анализа. Убедитесь, что ссылки корректные и токен валидный.")

        report_data["flow_links"] = all_flow_links
        report_data["standalone_labels"] = standalone_labels  # 🟢 ФИКС: Передаем отдельный список лейблов в рендерер

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
                
            # 🟢 ДИНАМИЧЕСКОЕ ПЕРЕКЛЮЧЕНИЕ СЕРВЕРА И ТОКЕНА ДЛЯ КАЖДОЙ НОДЫ
            source_url = node.get("_source_url", "")
            if source_url:
                b_match = re.search(rf'{re.escape(SYSTEM_DOMAIN)}/(\d+)', source_url) or re.search(r'/(\d+)(?:#|/|$)', source_url)
                if b_match:
                    new_brand = b_match.group(1)
                    new_env = "env2"
                    if "drive-7" in source_url: new_env = "env7"
                    elif "drive-5" in source_url: new_env = "env5"
                    
                    current_token = tokens.get(new_env) or tokens.get("env2", "")
                    api.brand_id = new_brand
                    api.headers["active_label_id"] = new_brand
                    api.headers["authorization"] = current_token
                    api.auth_token = current_token
                    
                    system_domain = SYSTEM_DOMAIN
                    if new_env == "env7":
                        api.boapi_host = f"boapi7.{system_domain}"
                        api.drive_host = f"drive-7.{system_domain}"
                        DRIVE_HOST = f"drive-7.{system_domain}"
                    elif new_env == "env5":
                        api.boapi_host = f"boapi5.{system_domain}"
                        api.drive_host = f"drive-5.{system_domain}"
                        DRIVE_HOST = f"drive-5.{system_domain}"
                    else:
                        api.boapi_host = f"boapi.{system_domain}"
                        api.drive_host = f"drive.{system_domain}"
                        DRIVE_HOST = f"drive.{system_domain}"
                    brand_id = new_brand

            name = node.get("name", "Unknown")
            node_id = node.get("id") 
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
                    "id": node_id,
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
                    "id": node_id,
                    "name": name,
                    "condition": cond_str
                })

            elif node_type == "Wait For":
                event_name = details.get("event_type_uiname") or details.get("event_type_name", "Unknown Event")
                timeout_ms = details.get("timeout", 0)
                
                # 🟢 ФИКС: Точное отображение часов, как на карте (без грубого округления до дней)
                if timeout_ms >= 86400000 and timeout_ms % 86400000 == 0: 
                    timeout_str = f"{timeout_ms // 86400000} days"
                elif timeout_ms >= 3600000 and timeout_ms % 3600000 == 0: 
                    timeout_str = f"{timeout_ms // 3600000} hours"
                elif timeout_ms >= 3600000:
                    timeout_str = f"{timeout_ms // 3600000}h {(timeout_ms % 3600000) // 60000}m"
                elif timeout_ms >= 60000: 
                    timeout_str = f"{timeout_ms // 60000} minutes"
                else: 
                    timeout_str = f"{timeout_ms} ms"
                
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
                    "id": node_id,
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
                    "id": node_id,
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
                    variations_list = [] # 🟢 ФИКС: Собираем вариации прямо здесь
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
                    "id": node_id,
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
                                variations_list = ext_details.get("variations", [])

                    elif node_type == "Pop-up":
                        title_text = content.get('title', '')
                        body_text = content.get('sub_title', '')
                        image_url = content.get('image_url', '')
                        button1 = content.get('button_text', '')
                        link_text = content.get('button_url', '')
                        
                        extra_fields_text = ""
                        ext_content = {}
                        
                        if res_id:
                            res_url = f"https://{DRIVE_HOST}/{brand_id}#/templated_popup/{res_id}"
                            ext_details = api.get_inapp_details(res_id)
                            if ext_details:
                                resource_name = ext_details.get("resource_name") or ext_details.get("name") or resource_name
                                s_id = ext_details.get("status_id")
                                status_map = {1: "Draft", 2: "Active", 3: "Paused", 6: "Archived"}
                                status_name = ext_details.get("status_name") or status_map.get(s_id, f"ID: {s_id}" if s_id else "N/A")
                                
                                # Распаковываем контент из body/content если он там спрятан
                                ext_content = ext_details.get("resource_content") or ext_details.get("content") or ext_details
                                if isinstance(ext_content, str) and ext_content.strip().startswith("{"):
                                    try: ext_content = json.loads(ext_content)
                                    except: ext_content = ext_details
                                    
                                if "body" in ext_details and isinstance(ext_details["body"], str) and ext_details["body"].strip().startswith("{"):
                                    try: ext_content.update(json.loads(ext_details["body"]))
                                    except: pass

                                title_text = ext_content.get("title") or ext_content.get("title_url") or title_text
                                body_text = ext_content.get("sub_title") or ext_content.get("subtitle") or ext_content.get("text") or ext_content.get("body") or body_text
                                
                                # Фикс для картинки: ищем по разным ключам и удаляем "None"
                                img_raw = ext_content.get("image_url") or ext_content.get("imageurl") or ext_content.get("image") or image_url
                                image_url = "" if str(img_raw).strip().lower() == "none" else img_raw
                                
                                button1 = ext_content.get("button_text") or ext_content.get("button1") or button1
                                link_text = ext_content.get("button_url") or ext_content.get("action") or ext_content.get("link") or link_text
                                variations_list = ext_details.get("variations", [])
                                
                                # Собираем только видимые дополнительные поля (никакого технического мусора)
                                extra_keys = ["title_2", "sub_title_2", "subtitle_2", "text_2", "body_2", "button_text_2", "button_url_2", "action_2", "next_button_text", "back_button_text"] + [f"offer_line_{i}" for i in range(1,11)]
                                extra_parts = []
                                for k in extra_keys:
                                    val = ext_content.get(k)
                                    if val and isinstance(val, str): extra_parts.append(val)
                                extra_fields_text = " ".join(extra_parts)
                                
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
                                variations_list = ext_details.get("variations", [])

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
                                variations_list = res_details.get("variations", [])
                                
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
                                        # 🟢 ФИКС: Используем профили, сохраненные именно для этой ноды
                                        active_personas = node.get("_personas") or qa_personas
                                        for desc, uid in active_personas.items():
                                            if progress_cb: progress_cb(f"👤 Рендерим юзера {desc}...", 55)
                                            pers_html = api.get_personalized_email_preview(full_raw_html, uid)
                                            b64_img = api.render_email_to_base64(pers_html) if pers_html else None
                                            if b64_img:
                                                email_previews.append({"desc": desc, "uid": uid, "b64": b64_img})
                                        rendered_emails_cache[m_id] = email_previews

                    if node_type == "Push" and actual_type != "Push PWA" and "pwa" in resource_name.lower():
                        actual_type = "Push PWA"

                    if actual_type == "Email": text_for_syntax = f"{subject_text} {body_text}"
                    elif actual_type == "Pop-up": text_for_syntax = f"{title_text} {body_text} {button1} {link_text} {image_url} {extra_fields_text}"
                    elif actual_type in ["Push", "Push PWA", "Inbox"]: text_for_syntax = f"{title_text} {body_text} {button1} {link_text} {image_url}"
                    elif actual_type == "SMS": text_for_syntax = body_text
                    else: text_for_syntax = f"{title_text} {body_text} {resource_name} {subject_text} {button1}"

                    report_data["deep_analysis"].append({
                        "id": node_id,
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
                        "previews": email_previews,
                        "variations": variations_list,
                        "_source_url": source_url,
                        "_brand_id": api.brand_id,          
                        "_boapi_host": api.boapi_host,      
                        "_auth_token": api.auth_token,
                        "_full_data_str": text_for_syntax,  # 🟢 ФИКС: Очищенный текст для парсера
                        "_popup_full_content": ext_content if actual_type == "Pop-up" else {} # 🟢 ФИКС: Полный объект для core.py
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
                    "id": node_id,
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
                    "previews": [],
                    "variations": [],
                    "_source_url": source_url,
                    "_brand_id": api.brand_id,          
                    "_boapi_host": api.boapi_host,      
                    "_auth_token": api.auth_token       
                })

        labels_by_config = {}

        def add_labels_to_config(text, source_url, depth):
            if not text: return
            b_match = re.search(rf'{re.escape(SYSTEM_DOMAIN)}/(\d+)', source_url) or re.search(r'/(\d+)(?:#|/|$)', source_url)
            brand = b_match.group(1) if b_match else brand_id
            env = "env2"
            if "drive-7" in source_url: env = "env7"
            elif "drive-5" in source_url: env = "env5"
            
            config_key = (env, brand)
            if config_key not in labels_by_config:
                labels_by_config[config_key] = {}
                
            found = re.findall(r'\{\{label\.[^\}]+\}\}', text)
            for l in found:
                if not api.is_ignored_label(l):
                    labels_by_config[config_key][l] = max(labels_by_config[config_key].get(l, 0), depth)

        for item in report_data["deep_analysis"]:
            src = item.get("_source_url", "")
            t = item.get('type')
            
            # 🟢 ФИКС: Используем собранный текст, где нет системного мусора
            full_text = item.get('_full_data_str', '')
            if not full_text:
                if t == 'Email': full_text = str(item.get('body', '')) + " " + str(item.get('subject', ''))
                elif t == 'SMS': full_text = str(item.get('body', ''))
                else: full_text = f"{item.get('title_url', '')} {item.get('body', '')} {item.get('link', '')} {item.get('subject', '')} {item.get('icon_url', '')} {item.get('image_url', '')} {item.get('button1', '')}"
            
            add_labels_to_config(full_text, src, 1)

        for sl_dict in standalone_labels_with_env:
            add_labels_to_config(sl_dict["label"], sl_dict["url"], 3)

        checked_labels = set()
        
        for (env, brand), env_labels_to_fetch in labels_by_config.items():
            if not env_labels_to_fetch: continue
            
            # Переключаем API на нужное окружение перед скачиванием
            current_token = tokens.get(env, "")
            api.brand_id = brand
            api.headers["active_label_id"] = brand
            api.headers["authorization"] = current_token
            api.auth_token = current_token
            
            system_domain = SYSTEM_DOMAIN
            if env == "env7":
                api.boapi_host = f"boapi7.{system_domain}"
                api.drive_host = f"drive-7.{system_domain}"
            elif env == "env5":
                api.boapi_host = f"boapi5.{system_domain}"
                api.drive_host = f"drive-5.{system_domain}"
            else:
                api.boapi_host = f"boapi.{system_domain}"
                api.drive_host = f"drive.{system_domain}"

            log(f"📚 Скачивание {len(env_labels_to_fetch)} макросов для {env.upper()} (Brand {brand})...", 70)
            
            while env_labels_to_fetch:
                lbl, current_depth = env_labels_to_fetch.popitem()
                
                check_key = (env, brand, lbl)
                if check_key in checked_labels:
                    continue
                checked_labels.add(check_key)
                
                clean_name = lbl.replace("{{label.", "").replace("}}", "")
                normalized_name = api.normalize_label_name(clean_name)
                
                log(f"🔎 Ищем [{env.upper()}]: {clean_name} (Вложенность: {current_depth})", 75)
                
                audit_data = api.get_label_data_with_variations(normalized_name, log)
                
                if audit_data:
                    # Складываем в общий кэш для генератора отчета
                    report_data["labels_data"][lbl] = audit_data
                    
                    if current_depth > 0:
                        combined_text = str(audit_data.get("default", ""))
                        for v in audit_data.get("variations", []):
                            combined_text += " " + str(v.get("tag_value", ""))
                            
                        nested_raw = set(re.findall(r'\{\{label\.[^\}]+\}\}', combined_text))
                        nested_labels = {l for l in nested_raw if not api.is_ignored_label(l) and (env, brand, l) not in checked_labels}
                        
                        if nested_labels:
                            log(f"   🪆 Найдено {len(nested_labels)} вложенных макросов. Кладем в очередь.", 76)
                            
                        for n_lbl in nested_labels:
                            env_labels_to_fetch[n_lbl] = max(env_labels_to_fetch.get(n_lbl, 0), current_depth - 1)

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
        
        # 🟢 ФИКС: Берем имя из первой кампании в новом массиве
        if report_data.get("general_list"):
            camp_name = report_data["general_list"][0]["general"].get("Name", "Audit")
        else:
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
def parse_template_dep_promo_x3(raw_text):
    result = {
        "template_name": "Dep Promo Code x3",
        "general_settings": {},
        "offers": []
    }
    
    # 🟢 ФИКС: Очищаем текст от невидимых кавычек и табов из Excel/Sheets
    clean_text = raw_text.replace('"', ' ').replace('\t', '\n\n')
    
    act_dur = re.search(r'Activation duration\s*-\s*(\d+)', clean_text, re.IGNORECASE)
    dur_hr = re.search(r'Duration hour\s*-\s*(\d+)', clean_text, re.IGNORECASE)
    seg = re.search(r'Сегменты с названием\s*-\s*([^\n]+)', clean_text, re.IGNORECASE)
    
    if act_dur: result["general_settings"]["activation_duration_hours"] = int(act_dur.group(1))
    if dur_hr: result["general_settings"]["duration_hours"] = int(dur_hr.group(1))
    if seg: result["general_settings"]["segments"] = seg.group(1).strip()

    date_match = re.search(r'(\d{2}\.\d{2})\s*-\s*(\d{2}\.\d{2})', clean_text)
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

    current_tier = "All Users"
    pending_tiers = []
    
    tier_pattern = r'(Tier\s*\d[^\n)]*\)?|VIP\s*Tier[^\n)]*\)?)'
    parts = re.split(tier_pattern, clean_text, flags=re.IGNORECASE)
    
    for part in parts:
        clean_part = part.strip()
        if not clean_part: continue
        
        if re.match(tier_pattern, clean_part, re.IGNORECASE):
            clean_tier = re.sub(r'[\t"\']', '', clean_part).strip()
            pending_tiers.append(clean_tier)
            continue
            
        if 'dep ' in clean_part.lower() and 'up to' in clean_part.lower():
            if pending_tiers:
                current_tier = " + ".join(pending_tiers)
                pending_tiers = []
                
            # 🟢 ФИКС: Умное разбиение по офферам, чтобы не зависеть от жесткого порядка строк
            offer_blocks = re.split(r'(?i)(?=dep\s+\d)', clean_part)
            
            for ob in offer_blocks:
                if 'up to' not in ob.lower(): continue
                
                offer = {"tier_name": current_tier}
                
                dep_m = re.search(r'dep\s+([\d,.]+)\s+([A-Z]{3})', ob, re.IGNORECASE)
                if dep_m:
                    offer["min_dep"] = int(float(dep_m.group(1).replace(',', '')))
                    offer["currency"] = dep_m.group(2).upper()
                    
                pct_m = re.search(r'(\d+)\s*%', ob)
                if pct_m: offer["bonus_percent"] = int(pct_m.group(1))
                
                up_to_m = re.search(r'up to\s+([\d,.]+)', ob, re.IGNORECASE)
                if up_to_m: offer["max_bonus"] = int(float(up_to_m.group(1).replace(',', '')))
                
                wager_m = re.search(r'wager\s*x?\s*(\d+)', ob, re.IGNORECASE)
                if wager_m: offer["wager"] = int(wager_m.group(1))
                
                uses_m = re.search(r'used\s+(\d+)', ob, re.IGNORECASE)
                if uses_m: offer["usage_limit"] = int(uses_m.group(1))
                
                promo_m = re.search(r'promo\s*code\s*:\s*([A-Z0-9]+)', ob, re.IGNORECASE)
                if promo_m: offer["promocode"] = promo_m.group(1).upper()
                
                if "min_dep" in offer and "max_bonus" in offer:
                    result["offers"].append(offer)

    if not result["offers"]:
        return {"error": "❌ Не удалось найти офферы по шаблону 'Dep Promo Code x3'. Проверьте текст."}
        
    return result

def parse_template_dep_promo_x3(raw_text):
    result = {
        "template_name": "Dep Promo Code x3",
        "general_settings": {},
        "offers": []
    }
    
    # 🟢 ФИКС: Очищаем текст от невидимых кавычек и табов из Excel/Sheets
    clean_text = raw_text.replace('"', ' ').replace('\t', '\n\n')
    
    act_dur = re.search(r'Activation duration\s*-\s*(\d+)', clean_text, re.IGNORECASE)
    dur_hr = re.search(r'Duration hour\s*-\s*(\d+)', clean_text, re.IGNORECASE)
    seg = re.search(r'Сегменты с названием\s*-\s*([^\n]+)', clean_text, re.IGNORECASE)
    
    if act_dur: result["general_settings"]["activation_duration_hours"] = int(act_dur.group(1))
    if dur_hr: result["general_settings"]["duration_hours"] = int(dur_hr.group(1))
    if seg: result["general_settings"]["segments"] = seg.group(1).strip()

    date_match = re.search(r'(\d{2}\.\d{2})\s*-\s*(\d{2}\.\d{2})', clean_text)
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

    current_tier = "All Users"
    pending_tiers = []
    
    tier_pattern = r'(Tier\s*\d[^\n)]*\)?|VIP\s*Tier[^\n)]*\)?)'
    parts = re.split(tier_pattern, clean_text, flags=re.IGNORECASE)
    
    for part in parts:
        clean_part = part.strip()
        if not clean_part: continue
        
        if re.match(tier_pattern, clean_part, re.IGNORECASE):
            pending_tiers.append(clean_part)
            continue
            
        if 'Dep ' in clean_part and 'up to' in clean_part:
            if pending_tiers:
                current_tier = " + ".join(pending_tiers)
                pending_tiers = []
                
            # 🟢 ФИКС: Умная регулярка, которая понимает новый порядок и пустые промокоды (для BRL)
            offer_regex = r'Dep\s+([\d,]+)\s+([A-Z]{3})\s*[-–—]\s*get\s+(\d+)\s*%\s*up to\s+([\d,]+)\s*[A-Z]{3}.*?promocode:\s*([A-Z0-9]*).*?Wager\s*x\s*(\d+).*?can be used\s+(\d+)\s+times'
            matches = re.finditer(offer_regex, clean_part, re.IGNORECASE | re.DOTALL)
            
            for match in matches:
                offer = {
                    "tier_name": current_tier,
                    "currency": match.group(2).upper(),
                    "min_dep": int(match.group(1).replace(',', '')),
                    "bonus_percent": int(match.group(3)),
                    "max_bonus": int(match.group(4).replace(',', '')),
                    "wager": int(match.group(6)),
                    "usage_limit": int(match.group(7))
                }
                promo = match.group(5).strip()
                if promo:
                    offer["promocode"] = promo
                result["offers"].append(offer)

    if not result["offers"]:
        return {"error": "❌ Не удалось найти офферы по шаблону 'Dep Promo Code x3'. Проверьте текст."}
        
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

    tier_pattern = r'(Tier\s*\d.*?\)|VIP\s*Tier.*?\))'
    parts = re.split(tier_pattern, raw_text, flags=re.IGNORECASE | re.DOTALL)
    
    if len(parts) > 1:
        for i in range(1, len(parts), 2):
            tier_name = parts[i].replace('\n', ' ').strip()
            tier_content = parts[i+1].replace('\n', '  ')
            
            # Универсальное разбиение: ищем "promo code:", всё что до него - это один оффер.
            if not re.search(r'promo\s*code:', tier_content, re.IGNORECASE):
                tier_content += " promo code: "
            
            blocks = re.split(r'promo\s*code:\s*([A-Z0-9]*)\s*', tier_content, flags=re.IGNORECASE)
            
            for j in range(0, len(blocks) - 1, 2):
                block_text = blocks[j]
                promocode = blocks[j+1].strip()
                
                # Вейджер теперь опциональный!
                wager_match = re.search(r'Wager\s*x(\d+)', block_text, re.IGNORECASE)
                wager = int(wager_match.group(1)) if wager_match else None
                
                # Ищем ступени лесенки и сразу достаем фриспины, если они есть
                step_regex = r'min dep\s+([\d,]+)\s+([A-Z]{3}).*?(\d+)%\s*up to\s+([\d,]+)(?:\s*[A-Z]{3})?(?:\s*\+\s*(\d+)\s*(?:HB\s*)?FS\s*\(\s*([\d.,]+)\s*[A-Z]{3}\s*\))?'
                step_matches = list(re.finditer(step_regex, block_text, re.IGNORECASE))
                
                if not step_matches: continue
                
                currency = step_matches[0].group(2).upper()
                ladder_steps = []
                fs_val = None
                val_val = None
                
                for sm in step_matches:
                    ladder_steps.append({
                        "min_dep": int(sm.group(1).replace(',', '')),
                        "bonus_percent": int(sm.group(3)),
                        "max_bonus": int(sm.group(4).replace(',', ''))
                    })
                    if sm.group(5): fs_val = int(sm.group(5))
                    if sm.group(6): val_val = float(sm.group(6).replace(',', '.'))
                    
                offer = {
                    "tier_name": tier_name,
                    "currency": currency,
                    "ladder_steps": ladder_steps
                }
                if promocode: offer["promocode"] = promocode
                if wager: offer["wager"] = wager
                if fs_val: offer["fs"] = fs_val
                if val_val: offer["value"] = val_val
                
                result["offers"].append(offer)
                
    if not result["offers"]:
        return {"error": "❌ Не удалось найти офферы по шаблону 'Deposit bonus ladder'."}
        
    return result

def parse_template_bonus_ladder(raw_text):
    result = {
        "template_name": "Bonus ladder",
        "general_settings": {},
        "offers": []
    }
    
    # Очищаем текст от табов и кавычек
    clean_text = raw_text.replace('"', ' ').replace('\t', '\n\n')
    
    act_dur = re.search(r'Activation duration\s*-\s*(\d+)', clean_text, re.IGNORECASE)
    dur_hr = re.search(r'Duration hour\s*-\s*(\d+)', clean_text, re.IGNORECASE)
    seg = re.search(r'Сегменты с названием\s*-\s*([^\n]+)', clean_text, re.IGNORECASE)
    
    usage = re.search(r'Использовать.*?до\s*(\d+)\s*раз', clean_text, re.IGNORECASE)
    if not usage: usage = re.search(r'can be used\s+(\d+)\s+times', clean_text, re.IGNORECASE)
    
    if act_dur: result["general_settings"]["activation_duration_hours"] = int(act_dur.group(1))
    if dur_hr: result["general_settings"]["duration_hours"] = int(dur_hr.group(1))
    if seg: result["general_settings"]["segments"] = seg.group(1).strip()
    if usage: result["general_settings"]["usage_limit"] = int(usage.group(1))

    date_match = re.search(r'(\d{2}\.\d{2})\s*-\s*(\d{2}\.\d{2})', clean_text)
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

    current_tier = "All Users"
    pending_tiers = []
    
    tier_pattern = r'(Tier\s*\d[^\n)]*\)?|VIP\s*Tier[^\n)]*\)?)'
    parts = re.split(tier_pattern, clean_text, flags=re.IGNORECASE)
    
    for part in parts:
        clean_part = part.strip()
        if not clean_part: continue
        
        # Склеивание тиров (Tier 3 + Tier 2)
        if re.match(tier_pattern, clean_part, re.IGNORECASE):
            clean_tier = re.sub(r'[\t"\']', '', clean_part).strip()
            pending_tiers.append(clean_tier)
            continue
            
        if 'min dep' in clean_part.lower():
            if pending_tiers:
                current_tier = " + ".join(pending_tiers)
                pending_tiers = []
                
            # Разделяем внутри тира на валютные блоки
            blocks = re.split(r'(?i)Bonus\s*ladder', clean_part)
            if len(blocks) <= 1:
                blocks = re.split(r'(?i)promocode:', clean_part)

            for block_text in blocks:
                if 'min dep' not in block_text.lower(): continue

                ladder_steps = []
                currency = "EUR" 
                
                # Построчный сбор ступенек лесенки
                step_matches = list(re.finditer(r'min dep\s+([\d,.]+)\s+([A-Z]{3})(.*)', block_text, re.IGNORECASE))
                
                for sm in step_matches:
                    dep_amount = int(float(sm.group(1).replace(',', '')))
                    currency = sm.group(2).upper()
                    remainder = sm.group(3)
                    
                    step_data = {"min_dep": dep_amount}
                    
                    fs_m = re.search(r'-\s*(\d+)\s*(?:HB\s*)?FS', remainder, re.IGNORECASE)
                    if fs_m:
                        step_data["fs"] = int(fs_m.group(1))
                        
                    ladder_steps.append(step_data)
                    
                if not ladder_steps: continue
                
                offer = {
                    "tier_name": current_tier,
                    "currency": currency,
                    "ladder_steps": ladder_steps
                }
                
                wager_match = re.search(r'Wager\s*x?\s*(\d+)', block_text, re.IGNORECASE)
                if wager_match: offer["wager"] = int(wager_match.group(1))
                
                val_match = re.search(r'Value:\s*([\d.,]+)', block_text, re.IGNORECASE)
                if val_match: offer["value"] = float(val_match.group(1).replace(',', '.'))
                
                promo_match = re.search(r'promocode:\s*([A-Z0-9]+)', block_text, re.IGNORECASE)
                if promo_match: offer["promocode"] = promo_match.group(1).upper()
                
                result["offers"].append(offer)

    if not result["offers"]:
        return {"error": "❌ Не удалось найти офферы по шаблону 'Bonus ladder'. Проверьте текст."}
        
    return result

def parse_template_bets_mission(raw_text):
    result = {
        "template_name": "Bets Mission",
        "general_settings": {},
        "offers": []
    }
    
    # Парсим настройки времени и активации
    act_dur = re.search(r'Activation duration\s*-\s*(\d+)', raw_text, re.IGNORECASE)
    dur_hr = re.search(r'Duration hour\s*-\s*(\d+)', raw_text, re.IGNORECASE)
    seg = re.search(r'Сегменты с названием\s*-\s*([^\n\t]+)', raw_text, re.IGNORECASE)
    
    if act_dur: result["general_settings"]["activation_duration_hours"] = int(act_dur.group(1))
    if dur_hr: result["general_settings"]["duration_hours"] = int(dur_hr.group(1))
    if seg: result["general_settings"]["segments"] = seg.group(1).strip()

    # Разбивка по тирам (Теперь понимает любой порядок тиров)
    tier_pattern = r'(Tier\s*\d.*?\)|VIP\s*Tier.*?\))'
    parts = re.split(tier_pattern, raw_text, flags=re.IGNORECASE | re.DOTALL)
    
    if len(parts) > 1:
        for i in range(1, len(parts), 2):
            tier_name = parts[i].replace('\n', ' ').strip()
            tier_content = parts[i+1].replace('\n', ' ')
            
            # Регулярка для миссии: сумма ставок, валюта, кол-во FS в день, всего FS, вейджер, цена спина
            mission_regex = r'Make\s+([\d,]+)\s+([A-Z]{3})\s+bets.*?get\s+(\d+)\s*(?:FS|HB FS).*?\(\s*(\d+)\s*(?:FS|HB FS).*?total\).*?Wager\s*x(\d+).*?[Vv]alue:\s*([\d.,]+)'
            matches = re.finditer(mission_regex, tier_content, re.IGNORECASE)
            
            for match in matches:
                # Специальные ключи для сверки с макросами, как ты и просил
                result["offers"].append({
                    "tier_name": tier_name,
                    "currency": match.group(2).upper(),
                    "amount": int(match.group(1).replace(',', '')),          # amount (ставка)
                    "fs": int(match.group(3)),                                # fs (bets_mission_fs_amount)
                    "fs_amount_all": int(match.group(4)),                     # fs_amount_all (bets_mission_fs_amount_all)
                    "wager": int(match.group(5)),
                    "value": float(match.group(6).replace(',', '.'))
                })
                
    if not result["offers"]:
        return {"error": "❌ Не удалось найти офферы по шаблону 'Bets Mission'. Проверьте текст."}
        
    return result

def parse_template_mega(raw_text, mega_type="react"):
    result = {
        "template_name": f"Mega {'React' if mega_type == 'react' else 'Reten'}",
        "general_settings": {},
        "offers": []
    }
    
    act_dur = re.search(r'Activation duration\s*-\s*(\d+)', raw_text, re.IGNORECASE)
    dur_hr = re.search(r'Duration hour\s*-\s*(\d+)', raw_text, re.IGNORECASE)
    if act_dur: result["general_settings"]["activation_duration_hours"] = int(act_dur.group(1))
    if dur_hr: result["general_settings"]["duration_hours"] = int(dur_hr.group(1))

    slot_match = re.search(r'Slot:[\s\n]+([^\n]+)', raw_text, re.IGNORECASE)
    if slot_match: 
        result["general_settings"]["slot"] = slot_match.group(1).strip()

    # Бьем текст по тирам
    tier_pattern = r'(Tier\s*\d.*?\)|VIP\s*Tier.*?\))'
    parts = re.split(tier_pattern, raw_text, flags=re.IGNORECASE | re.DOTALL)
    
    if len(parts) > 1:
        for i in range(1, len(parts), 2):
            tier_name = parts[i].replace('\n', ' ').strip()
            tier_content = parts[i+1]
            
            is_react = "reactivation" in tier_content.lower()
            is_reten = "retention" in tier_content.lower()

            # Отсекаем ненужную половину текста
            if mega_type == "react" and not is_react: continue
            if mega_type == "reten" and not is_reten: continue
                
            if mega_type == "react":
                blocks = re.split(r'Mega reactivation:', tier_content, flags=re.IGNORECASE)
                for block in blocks:
                    if not block.strip() or "Drop Spins" not in block: continue
                    
                    currency_match = re.search(r'\b(EUR|BRL|USD|PLN|CAD|AUD)\b', block, re.IGNORECASE)
                    currency = currency_match.group(1).upper() if currency_match else "EUR"
                    min_dep_match = re.search(r'min dep\s+([\d,]+)', block, re.IGNORECASE)
                    wager_match = re.search(r'wager\s*x(\d+)', block, re.IGNORECASE)
                    wheel_fs_match = re.search(r'Drop Spins.*?\((\d+)\s*(?:HB\s*)?FS\)', block, re.IGNORECASE)
                    
                    block_no_wheel = re.sub(r'Drop Spins.*?\n', '', block, flags=re.IGNORECASE)
                    match_bonus = re.search(r'(\d+)%\s*up to\s*([\d,]+)', block_no_wheel, re.IGNORECASE)
                    main_fs_match = re.search(r'(?:\+|\n)\s*(\d+)\s*(?:HB\s*)?FS', block_no_wheel, re.IGNORECASE)
                    
                    offer = {"tier_name": tier_name, "currency": currency}
                    if min_dep_match: offer["min_dep"] = int(min_dep_match.group(1).replace(',', ''))
                    if wager_match: offer["wager"] = int(wager_match.group(1))
                    if wheel_fs_match: offer["wheel_fs"] = int(wheel_fs_match.group(1))
                    if main_fs_match: offer["fs"] = int(main_fs_match.group(1))
                    if match_bonus:
                        offer["bonus_percent"] = int(match_bonus.group(1))
                        offer["max_bonus"] = int(match_bonus.group(2).replace(',', ''))
                        
                    if len(offer) > 2: result["offers"].append(offer)

            elif mega_type == "reten":
                blocks = re.split(r'Mega retention(?: ladder)?:', tier_content, flags=re.IGNORECASE)
                for block in blocks:
                    if not block.strip() or "min dep" not in block.lower(): continue
                    
                    currency_match = re.search(r'\b(EUR|BRL|USD|PLN|CAD|AUD)\b', block, re.IGNORECASE)
                    currency = currency_match.group(1).upper() if currency_match else "EUR"
                    promo_match = re.search(r'promo code:\s*([A-Za-z0-9]+)', block, re.IGNORECASE)
                    
                    offer = {"tier_name": tier_name, "currency": currency, "ladder_steps": []}
                    if promo_match: offer["promocode"] = promo_match.group(1).upper()
                    
                    # 🟢 ФИКС: Убрали ленивый поиск (.*?) перед фриспинами. Теперь парсер жестко ищет валюту и знак "+"
                    step_regex = r'Min dep\s+([\d,]+)\s*(?:[A-Z]{3})?\s*-\s*(\d+)%\s*up to\s*([\d,]+)\s*(?:[A-Z]{3})?(?:\s*\+\s*(\d+)\s*(?:HB\s*)?(?:FS|Free Spins))?'
                    step_matches = re.finditer(step_regex, block, re.IGNORECASE)
                    
                    for m in step_matches:
                        step = {
                            "min_dep": int(m.group(1).replace(',', '')),
                            "bonus_percent": int(m.group(2)),
                            "max_bonus": int(m.group(3).replace(',', ''))
                        }
                        if m.group(4): step["fs"] = int(m.group(4))
                        offer["ladder_steps"].append(step)
                        
                    if offer["ladder_steps"]: result["offers"].append(offer)

    if not result["offers"]:
        return {"error": f"❌ Не удалось найти офферы по типу 'Mega {mega_type.capitalize()}'. Проверьте текст."}
        
    return result

def parse_template_dep_promo_x3(raw_text):
    result = {
        "template_name": "Dep Promo Code x3",
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

    current_tier = "All Users"
    pending_tiers = []
    
    # Разделяем текст по Тирам, запоминаем склеенные (Tier 2 + Tier 3)
    tier_pattern = r'(Tier\s*\d[^\n)]*\)?|VIP\s*Tier[^\n)]*\)?)'
    parts = re.split(tier_pattern, raw_text, flags=re.IGNORECASE)
    
    for part in parts:
        clean_part = part.strip()
        if not clean_part: continue
        
        # Если кусок - название Тира
        if re.match(tier_pattern, clean_part, re.IGNORECASE):
            clean_tier = re.sub(r'[\t"\']', '', clean_part).strip()
            pending_tiers.append(clean_tier)
            continue
            
        # Ищем блок офферов
        if 'Dep ' in clean_part and 'up to' in clean_part:
            if pending_tiers:
                current_tier = " + ".join(pending_tiers)
                pending_tiers = []
                
            # Умная регулярка, которая понимает пустые промокоды и перенос строк
            offer_regex = r'Dep\s+([\d,]+)\s+([A-Z]{3})\s*-\s*get\s+(\d+)%\s*up to\s+([\d,]+)\s*[A-Z]{3}.*?promocode:\s*([A-Z0-9]*).*?Wager\s*x(\d+).*?can be used\s+(\d+)\s+times'
            matches = re.finditer(offer_regex, clean_part, re.IGNORECASE | re.DOTALL)
            
            for match in matches:
                offer = {
                    "tier_name": current_tier,
                    "currency": match.group(2).upper(),
                    "min_dep": int(match.group(1).replace(',', '')),
                    "bonus_percent": int(match.group(3)),
                    "max_bonus": int(match.group(4).replace(',', '')),
                    "wager": int(match.group(6)),
                    "usage_limit": int(match.group(7))
                }
                promo = match.group(5).strip()
                if promo:
                    offer["promocode"] = promo
                result["offers"].append(offer)

    if not result["offers"]:
        return {"error": "❌ Не удалось найти офферы по шаблону 'Dep Promo Code x3'. Проверьте текст."}
        
    return result

def parse_template_mid_month_react(raw_text):
    result = {
        "template_name": "Mid Month React",
        "general_settings": {},
        "offers": []
    }
    
    clean_text = raw_text.replace('"', ' ').replace('\t', '\n\n')
    
    act_dur = re.search(r'Activation duration\s*-\s*(\d+)', clean_text, re.IGNORECASE)
    dur_hr = re.search(r'Duration hour\s*-\s*(\d+)', clean_text, re.IGNORECASE)
    seg = re.search(r'Сегменты с названием\s*-\s*([^\n]+)', clean_text, re.IGNORECASE)
    slot_match = re.search(r'Slot:[\s\n]+([^\n]+)', clean_text, re.IGNORECASE)
    
    if act_dur: result["general_settings"]["activation_duration_hours"] = int(act_dur.group(1))
    if dur_hr: result["general_settings"]["duration_hours"] = int(dur_hr.group(1))
    if seg: result["general_settings"]["segments"] = seg.group(1).strip()
    if slot_match: result["general_settings"]["slot"] = slot_match.group(1).strip()

    date_match = re.search(r'(\d{2}\.\d{2})\s*-\s*(\d{2}\.\d{2})', clean_text)
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

    current_tier = "All Users"
    pending_tiers = []
    
    tier_pattern = r'(Tier\s*\d[^\n)]*\)?|VIP\s*Tier[^\n)]*\)?)'
    parts = re.split(tier_pattern, clean_text, flags=re.IGNORECASE)
    
    for part in parts:
        clean_part = part.strip()
        if not clean_part: continue
        
        if re.match(tier_pattern, clean_part, re.IGNORECASE):
            clean_tier = re.sub(r'[\t"\']', '', clean_part).strip()
            pending_tiers.append(clean_tier)
            continue
            
        if 'min dep' in clean_part.lower():
            if pending_tiers:
                current_tier = " + ".join(pending_tiers)
                pending_tiers = []
                
            # Разбиваем кусок тира на отдельные офферы по ключевому слову Reactivation
            offer_blocks = re.split(r'(?i)(?=Reactivation)', clean_part)
            if len(offer_blocks) <= 1:
                offer_blocks = re.split(r'(?i)(?=Spins wheel|Drop Spins)', clean_part)
            
            for ob in offer_blocks:
                if 'min dep' not in ob.lower(): continue
                
                offer = {"tier_name": current_tier}
                
                dep_m = re.search(r'min dep\s+([\d,.]+)\s+([A-Z]{3})', ob, re.IGNORECASE)
                if dep_m:
                    offer["min_dep"] = int(float(dep_m.group(1).replace(',', '')))
                    offer["currency"] = dep_m.group(2).upper()
                    
                wager_m = re.search(r'wager\s*x?\s*(\d+)', ob, re.IGNORECASE)
                if wager_m: offer["wager"] = int(wager_m.group(1))
                
                # Ищем фриспины для колеса
                wheel_m = re.search(r'(?:Spins wheel|Drop Spins).*?\((\d+)\s*(?:Free Spins|FS|HB FS)\)', ob, re.IGNORECASE)
                if wheel_m: offer["wheel_fs"] = int(wheel_m.group(1))
                
                # Ищем основные фриспины
                fs_m = re.search(r'\+\s*(\d+)\s*(?:FS|Free Spins|HB FS)', ob, re.IGNORECASE)
                if fs_m: offer["fs"] = int(fs_m.group(1))
                
                # Ищем процентный бонус
                match_bonus = re.search(r'\+\s*(\d+)%\s*up to\s*([\d,.]+)', ob, re.IGNORECASE)
                if match_bonus:
                    offer["bonus_percent"] = int(match_bonus.group(1))
                    offer["max_bonus"] = int(float(match_bonus.group(2).replace(',', '')))
                    
                if "min_dep" in offer and ("fs" in offer or "bonus_percent" in offer or "wheel_fs" in offer):
                    result["offers"].append(offer)

    if not result["offers"]:
        return {"error": "❌ Не удалось найти офферы по шаблону 'Mid Month React'. Проверьте текст."}
        
    return result

def parse_template_choose_bonus(raw_text):
    result = {
        "template_name": "Choose your Bonus",
        "general_settings": {},
        "offers": []
    }
    
    # Парсим общие настройки
    act_dur = re.search(r'Activation duration\s*-\s*(\d+)', raw_text, re.IGNORECASE)
    dur_hr = re.search(r'Duration hour\s*-\s*(\d+)', raw_text, re.IGNORECASE)
    seg = re.search(r'Сегменты с названием\s*-\s*([^\n\t]+)', raw_text, re.IGNORECASE)
    
    if act_dur: result["general_settings"]["activation_duration_hours"] = int(act_dur.group(1))
    if dur_hr: result["general_settings"]["duration_hours"] = int(dur_hr.group(1))
    if seg: result["general_settings"]["segments"] = seg.group(1).strip()
    
    current_tier = "All Users"
    pending_tiers = []
    
    # 🟢 ФИКС: Умное разделение текста. 
    # Сначала бьем текст по Тирам, чтобы сохранять их в памяти
    tier_pattern = r'(Tier\s*\d[^\n)]*\)?|VIP\s*Tier[^\n)]*\)?)'
    parts = re.split(tier_pattern, raw_text, flags=re.IGNORECASE)
    
    for part in parts:
        clean_part = part.strip()
        if not clean_part: continue
        
        # 1. Если кусок текста - это название Тира, запоминаем его в очередь
        if re.match(tier_pattern, clean_part, re.IGNORECASE):
            clean_tier = re.sub(r'[\t"\']', '', clean_part).strip()
            pending_tiers.append(clean_tier)
            continue
            
        # 2. Если это блок с офферами (есть Min dep или Choose)
        if 'Min dep' in clean_part or 'Choose your Bonus' in clean_part:
            # Если в очереди есть Тиры (например, "Tier 3" и "Tier 2"), склеиваем их плюсом
            if pending_tiers:
                current_tier = " + ".join(pending_tiers)
                pending_tiers = []
            
            # Теперь внутри этого куска ищем отдельные блоки "Choose your Bonus"
            blocks = re.split(r'Choose your Bonus', clean_part, flags=re.IGNORECASE)
            
            for block in blocks:
                if not block.strip() or 'Min dep' not in block: continue
                
                # Ищем минимальный депозит
                dep_match = re.search(r'Min dep\s+([\d,]+)\s+([A-Z]{3})', block, re.IGNORECASE)
                if not dep_match: continue
                min_dep = int(dep_match.group(1).replace(',', ''))
                currency = dep_match.group(2).upper()
                
                # ОПЦИЯ 1: Фриспины (Free Spins)
                fs_match = re.search(r'(?:Code:\s*([A-Z0-9]+)\s*-\s*)?(\d+)\s*(?:HB\s*)?FS\s*\(([\d.,]+)\s*[A-Z]{3}.*?w(?:ager)?\s*x(\d+)\)', block, re.IGNORECASE)
                if fs_match:
                    fs_offer = {
                        "tier_name": current_tier,
                        "currency": currency,
                        "min_dep": min_dep,
                        "fs": int(fs_match.group(2)),
                        "value": float(fs_match.group(3).replace(',', '.')),
                        "wager": int(fs_match.group(4))
                    }
                    if fs_match.group(1): fs_offer["promocode"] = fs_match.group(1).upper()
                    result["offers"].append(fs_offer)
                    
                # ОПЦИЯ 2: Процентный бонус (Match Bonus)
                match_regex = re.search(r'(?:Code:\s*([A-Z0-9]+)\s*-\s*)?(\d+)%\s*up to\s*([\d,]+)(?:\s*[A-Z]{3})?.*?(?:w(?:ager)?\s*x(\d+))?', block, re.IGNORECASE)
                if match_regex:
                    match_offer = {
                        "tier_name": current_tier,
                        "currency": currency,
                        "min_dep": min_dep,
                        "bonus_percent": int(match_regex.group(2)),
                        "max_bonus": int(match_regex.group(3).replace(',', ''))
                    }
                    if match_regex.group(1): match_offer["promocode"] = match_regex.group(1).upper()
                    if match_regex.group(4): match_offer["wager"] = int(match_regex.group(4))
                    result["offers"].append(match_offer)
                    
    if not result["offers"]:
        return {"error": "❌ Не удалось найти офферы по шаблону 'Choose your Bonus'. Проверьте скопированный текст."}
        
    return result

# =====================================================================
# 🚀 ЭНДПОИНТ API (Streaming SSE)
# =====================================================================
@router.post("/generate")
async def generate_single_report_stream(request: SingleReportRequest):
    """
    Запускает одиночный аудит кампании в фоновом потоке.
    """
    valid_tasks = [t for t in request.tasks if t.value.strip()]
    if not valid_tasks:
        raise HTTPException(status_code=400, detail="Необходимо передать хотя бы один элемент для проверки.")

    # 🎯 ВНЕДРЯЕМ ЛОГИКУ РАСПОЗНАВАНИЯ ШАБЛОНА
    expected_data = None
    if request.template_choice and request.template_choice != "Без сверки" and request.raw_table_data:
        choice = request.template_choice.lower()
        raw_text = request.raw_table_data
        
        if "dep promo code x3" in choice or "dep promo" in choice:
            expected_data = parse_template_dep_promo_x3(raw_text)
        elif "mid month react" in choice or "mid month" in choice:
            expected_data = parse_template_mid_month_react(raw_text)
        elif "deposit bonus ladder" in choice or "ступен" in choice:
            expected_data = parse_template_deposit_ladder(raw_text)
        elif "bonus ladder" in choice:
            expected_data = parse_template_bonus_ladder(raw_text)
        elif "mission" in choice or "мисси" in choice:
            expected_data = parse_template_bets_mission(raw_text)
        elif "choose" in choice or "выбор" in choice:
            expected_data = parse_template_choose_bonus(raw_text)
        elif "mega" in choice or "react" in choice:
            expected_data = parse_template_mega(raw_text, request.mega_type)
        else:
            expected_data = {"error": "❌ Шаблон не распознан. Выберите правильный шаблон из списка."}
            
        # Если парсер вернул ошибку формата, сразу отбиваем запрос, чтобы не крутить аудит впустую
        if expected_data and "error" in expected_data:
            raise HTTPException(status_code=400, detail=expected_data["error"])

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
                    tasks=valid_tasks,
                    tokens=request.tokens or {"env2": request.token},
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