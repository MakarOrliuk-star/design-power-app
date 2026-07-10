import requests
import json
import re
import os
import webbrowser
import urllib.parse
import random
import streamlit as st
from datetime import timedelta
from datetime import datetime
from playwright.sync_api import sync_playwright

# Импортируем твое ядро
from smartico_core_prod import SmarticoCore

# =====================================================================
# ⚙️ НАСТРОЙКИ
# =====================================================================
TARGET_URL = "https://drive.smartico.ai/2828#/j_audience_head/1422651"
AUTH_TOKEN = "ffa95d2c-5296-11f1-ba3d-068c3067dc9d"

# 📅 За какой период (в днях) собирать статистику для карты Flow Map
LIVE_VIEW_DAYS = 14 
# =====================================================================

def run_standalone_audit(url, token, use_live_view=True, days_back=14):
    brand_match = re.search(r"smartico\.ai/(\d+)", url)
    camp_match = re.search(r"(?:scheduled|head)/(\d+)", url)
    
    if not brand_match or not camp_match:
        print("❌ Ошибка: Неверная ссылка")
        return

    brand_id = brand_match.group(1)
    camp_id = camp_match.group(1)
    
    env_match = re.search(r"drive(?:-(\d+))?\.smartico\.ai", url)
    env_suffix = env_match.group(1) if env_match and env_match.group(1) else ""
    boapi_host = f"boapi{env_suffix}.smartico.ai" if env_suffix else "boapi.smartico.ai"
    drive_host = env_match.group(0) if env_match else "drive.smartico.ai"

    with sync_playwright() as p:
        # Эти аргументы критически важны для работы внутри Streamlit на macOS/Linux
        browser = p.chromium.launch(
            headless=True, 
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
        )
        context = browser.new_context()
        
        core = SmarticoCore(context, token, brand_id, boapi_host, drive_host)
        
        print(f"🚀 Процессинг кампании #{camp_id}...")

        # 1. Метаданные и Сегменты
        general_data, segment_data = core.get_campaign_metadata(camp_id, url)
        
        # 2. ПРОВЕРКА КОНТЕКСТА
        context_status = core.check_context_campaign_tag(camp_id, url)

        # 3. СБОР КАРТЫ ФЛОУ СО СТАТИСТИКОЙ
        # Увеличим визуальный контроль
        st.toast(f"Запрашиваем Flow Map за {days_back} дн. Ожидайте...")
        f_nodes, f_trans, audit_period = core.get_flow_data_live(
            camp_id, 
            log_cb=lambda msg, pct: st.write(f"  `{msg}`"), # Пишем логи прямо в UI Streamlit
            use_live_view=use_live_view,
            days_back=days_back
        )
        flow_html = core.build_flow_html(f_nodes, f_trans)

        # ⚡️ ИСПРАВЛЕНИЕ "МАТРЕШКИ": Убираем внутренний спойлер карты, оставляя только внешний
        flow_html = re.sub(r'<details[^>]*>\s*<summary[^>]*>.*?Интерактивная карта.*?</summary>', '<div style="padding-top: 10px;">', flow_html, count=1, flags=re.DOTALL)
        flow_html = re.sub(r'</details>\s*$', '</div>', flow_html)

        # ⚡ ВЫЧИСЛЯЕМ ОБЩЕЕ КОЛИЧЕСТВО ВХОДОВ
        # Берем максимальное значение report_activities_count среди всех нод
        # (Стартовая нода всегда имеет максимальный трафик)
        total_entries = 0
        if f_nodes:
            for n in f_nodes:
                count = n.get("report_activities_count")
                if count and str(count).isdigit():
                    total_entries = max(total_entries, int(count))

        # 3.5 СБОР РЕАЛЬНЫХ ОТПРАВОК (100 логов -> 2 случайных + Таблица ошибок)
        now = datetime.utcnow()
        past = now - timedelta(days=days_back)
        def esc(t): return str(t).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')
        
        communications_html = "<div style='display:flex; gap:16px; flex-wrap:wrap; justify-content:center;'>"
        found_any = False
        failed_records = [] # Хранилище для всех ошибок

        for act_id, act_name in [(50, "Email"), (40, "Push"), (60, "SMS")]:
            filter_dict = {
                "interval": {"from": past.strftime("%Y-%m-%dT00:00:00Z"), "to": now.strftime("%Y-%m-%dT23:59:59Z")},
                "audience_id": str(camp_id),
                "activity_type_id": act_id
            }
            params = urllib.parse.urlencode({
                "filter": json.dumps(filter_dict),
                "range": json.dumps([0, 99]), # ⚡ БЕРЕМ 100 ПОСЛЕДНИХ СОБЫТИЙ
                "sort": json.dumps(["id", "DESC"]),
                "lbl": brand_id
            })
            logs_url = f"https://{boapi_host}/api/campaign_communication_log?{params}"
            
            try:
                res_logs = requests.get(logs_url, headers={"accept": "application/json", "authorization": token, "active_label_id": brand_id}, timeout=20)
                if res_logs.ok:
                    logs_data = res_logs.json()
                    items = logs_data.get("result", logs_data) if isinstance(logs_data, dict) else logs_data
                    
                    # ⚡️ ЩИТ ОТ КРИВОГО ОТВЕТА API ⚡️
                    # Если API вернул словарь с ошибкой, а не список логов — пропускаем
                    if not isinstance(items, list):
                        continue
                    
                    if not items: continue
                    found_any = True

                    # 1. Собираем все ошибки из этих 100
                    for em in items:
                        if em.get("fail_reason_id") or em.get("fail_send_date"):
                            f_reason = em.get("fail_reason_text", "Unknown Error")
                            f_date = str(em.get("create_date", "")).replace("T", " ")[:19]
                            f_user = em.get("user_ext_id", "N/A")
                            failed_records.append((act_name, f_date, f_user, f_reason))

                    # 2. Выбираем 2 СЛУЧАЙНЫХ лога для карточек
                    target_items = random.sample(items, min(5, len(items)))
                    
                    for em in target_items:
                        u_id = em.get("user_ext_id", "N/A")
                        dt = str(em.get("create_date", "")).replace("T", " ")[:19]
                        r_name = em.get("resource_name", "N/A")
                        
                        # ID для тела
                        res_id = em.get("resource_id")
                        eng_uid = em.get("engagement_uid")
                        secret = em.get("secret")
                        r_type = em.get("resource_type_id")
                        eng_id = em.get("engagement_id")
                        sent_brand_id = em.get("crm_brand_id")

                        # Ссылки
                        internal_user_id = em.get("user_id")
                        if internal_user_id:
                            user_url = f"https://{drive_host}/{brand_id}#/users/{internal_user_id}/show/cj_user_state_advance"
                            user_clickable = f"<a href='{user_url}' target='_blank' style='color:#3b82f6; text-decoration:underline; font-weight:bold;'>{esc(u_id)}</a>"
                        else:
                            user_clickable = esc(u_id)

                        if res_id:
                            tmpl_type = "templated_mail" if act_id == 50 else ("resource_push" if act_id == 40 else "resource_sms")
                            template_url = f"https://{drive_host}/{brand_id}#/{tmpl_type}/{res_id}"
                            template_clickable = f"<a href='{template_url}' target='_blank' style='color:#3b82f6; text-decoration:underline;'>{esc(r_name)}</a>"
                        else:
                            template_clickable = esc(r_name)

                        # Статус
                        if em.get("fail_reason_id") or em.get("fail_send_date"):
                            status = f"❌ Failed <span style='color:#ef4444; font-size:11px;'>(Причина: {esc(em.get('fail_reason_text', 'Unknown'))})</span>"
                        elif em.get("delivered_date"):
                            status = "✅ Delivered"
                        else:
                            status = "⏳ Sent"
                            
                        # Запрос тела
                        body_html = ""
                        raw_body_data = {}
                        subj, from_email, reply_to = "N/A", "N/A", "N/A"
                        
                        if res_id and eng_uid and secret and r_type:
                            payload = {
                                "method": "getResourceBody",
                                "params": {"resource_id": res_id, "engagement_uid": eng_uid, "secret": secret, "type": r_type, "engagement_id": eng_id, "sent_brand_id": sent_brand_id}
                            }
                            body_url = f"https://{boapi_host}/api/private-api?method=getResourceBody&lbl={brand_id}"
                            try:
                                body_res = requests.post(body_url, json=payload, headers={"accept": "application/json", "authorization": token, "active_label_id": brand_id, "content-type": "application/json"}, timeout=20)
                                if body_res.ok:
                                    body_data = body_res.json()
                                    if act_id == 50:
                                        body_html = body_data.get("body", "")
                                        subj = body_data.get("subject", "N/A")
                                        from_email = body_data.get("from", "N/A")
                                        reply_to = body_data.get("reply_to", "N/A")
                                    else:
                                        raw_body_data = body_data.get("body", body_data)
                            except Exception as e:
                                print(f"⚠️ Ошибка получения тела {act_name}: {e}")

                        # Рендер UI
                        content_ui = ""
                        icon = "📦"
                        if act_id == 50:
                            img_html = ""
                            if body_html:
                                b64_img = core.render_email_to_base64(body_html)
                                if b64_img: img_html = f"<div style='margin-top:12px; border:1px solid #e2e8f0; border-radius:8px; overflow:hidden;'><img src='data:image/jpeg;base64,{b64_img}' style='width:100%; display:block;' loading='lazy'></div>"
                            content_ui = f"<div style='font-size:12px; color:#334155; background:#f8fafc; padding:10px; border-left:3px solid #3b82f6; border-radius:4px; word-break:break-all;'><div style='margin-bottom:4px;'><b>Subject:</b> {esc(subj)}</div><div style='margin-bottom:4px;'><b>From:</b> {esc(from_email)}</div><div><b>Reply-to:</b> {esc(reply_to)}</div></div>{img_html}"
                            icon = "📧"
                        elif act_id == 40:
                            p_data = raw_body_data if isinstance(raw_body_data, dict) else {}
                            p_title = p_data.get("title", p_data.get("subject", ""))
                            p_body = p_data.get("body", p_data.get("text", str(raw_body_data)))
                            p_img = p_data.get("imageUrl", "")
                            p_icon = p_data.get("iconUrl", "") # ⚡️ Достаем иконку
                            
                            t_len, b_len = len(p_title), len(p_body)
                            t_warn = "color:#ef4444;" if t_len > 27 else "color:#10b981;"
                            b_warn = "color:#ef4444;" if b_len > 75 else "color:#10b981;"
                            
                            stats_html = f"<div style='margin-bottom:12px; font-size:11px; display:flex; gap:10px;'><span style='background:#f1f5f9; padding:2px 6px; border-radius:4px; border:1px solid #cbd5e1;'><b style='{t_warn}'>Title:</b> {t_len} симв.</span><span style='background:#f1f5f9; padding:2px 6px; border-radius:4px; border:1px solid #cbd5e1;'><b style='{b_warn}'>Body:</b> {b_len} симв.</span></div>"
                            
                            # ⚡️ Шапка пуша с иконкой (имитация мобильного интерфейса)
                            push_header = ""
                            if p_icon:
                                push_header = f"<div style='display:flex; align-items:center; gap:8px; margin-bottom:8px;'><img src='{p_icon}' style='width:20px; height:20px; border-radius:4px;' loading='lazy'><span style='font-size:11px; color:#64748b; font-weight:600;'>Push Notification</span></div>"
                            
                            # Главная картинка
                            img_html = f"<div style='margin-top:12px;'><img src='{p_img}' style='width:100%; border-radius:12px; display:block; border:1px solid #e2e8f0;' loading='lazy'></div>" if p_img else ""
                            
                            # Рендерим саму карточку пуша: белый фон, тень и скругления как в Android/iOS
                            content_ui = f"<div style='font-size:13px; color:#334155; background:#ffffff; padding:14px; border:1px solid #e2e8f0; border-radius:16px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);'>{stats_html}{push_header}<div style='font-weight:bold; margin-bottom:4px; color:#0f172a; font-size:14px;'>{esc(p_title)}</div><div style='color:#475569;'>{esc(p_body)}</div>{img_html}</div>"
                            icon = "📲"
                        elif act_id == 60:
                            sms_text = raw_body_data.get("body", raw_body_data.get("text", str(raw_body_data))) if isinstance(raw_body_data, dict) else str(raw_body_data)
                            gsm7_chars = set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€")
                            non_gsm7 = set(c for c in sms_text if c not in gsm7_chars)
                            encoding = "UCS-2" if non_gsm7 else "GSM-7"
                            sim_len = len(sms_text)
                            parts = (sim_len // 153) + (1 if sim_len % 153 else 0) if encoding == "GSM-7" else (sim_len // 67) + (1 if sim_len % 67 else 0)
                            if parts == 0 or (sim_len <= 160 and encoding == "GSM-7") or (sim_len <= 70 and encoding == "UCS-2"): parts = 1
                            warn_badge = f"<div style='margin-bottom:8px; padding:6px; background:#fef2f2; border:1px solid #fca5a5; color:#b91c1c; font-size:11px; border-radius:4px;'>⚠️ <b>Внимание: кодировка UCS-2</b> (символы: <code>{esc(''.join(non_gsm7))}</code>)</div>" if non_gsm7 else ""
                            parts_color = "#b91c1c" if parts > 1 else "#10b981"
                            stats_html = f"{warn_badge}<div style='margin-bottom:10px; font-size:11px;'><span style='background:#f8fafc; padding:3px 8px; border-radius:4px; border:1px solid #cbd5e1;'><b>Длина:</b> {sim_len} | <b>Частей:</b> <span style='color:{parts_color}; font-weight:bold;'>{parts} SMS</span> ({encoding})</span></div>"
                            content_ui = f"<div style='background: #e2e8f0; padding: 16px; border-radius: 12px; font-family: sans-serif;'>{stats_html}<div style='background: #10b981; color: white; padding: 12px; border-radius: 18px 18px 4px 18px; font-size: 14px; white-space: pre-wrap; word-break: break-word;'>{esc(sms_text)}</div></div>"
                            icon = "💬"
                            
                        communications_html += f'''
                        <div style='flex: 1 1 45%; min-width:350px; max-width:600px; background:#ffffff; border:1px solid #cbd5e1; border-radius:12px; padding:16px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);'>
                            <div style='font-weight:bold; color:#1e293b; margin-bottom:12px; font-size:16px; border-bottom:1px solid #f1f5f9; padding-bottom:8px;'>{icon} {act_name} | 👤 User: {user_clickable}</div>
                            <div style='font-size:13px; color:#475569; margin-bottom:4px;'><b>Status:</b> {status}</div>
                            <div style='font-size:13px; color:#475569; margin-bottom:4px;'><b>Date:</b> {dt}</div>
                            <div style='font-size:13px; color:#475569; margin-bottom:10px;'><b>Template:</b> {template_clickable}</div>
                            {content_ui}
                        </div>
                        '''
            except Exception as e:
                print(f"⚠️ Ошибка загрузки логов {act_name}: {e}")
                
        communications_html += "</div>"
        
        # 3. ПОСТРОЕНИЕ ТАБЛИЦЫ ОШИБОК
        fails_html = ""
        if failed_records:
            fails_rows = ""
            for r_ch, r_dt, r_usr, r_rsn in failed_records:
                fails_rows += f"<tr style='border-bottom:1px solid #e2e8f0;'><td style='padding:8px 12px; font-weight:bold; color:#475569;'>{r_ch}</td><td style='padding:8px 12px;'>{r_dt}</td><td style='padding:8px 12px; color:#1e293b;'>{esc(r_usr)}</td><td style='padding:8px 12px; color:#ef4444;'>{esc(r_rsn)}</td></tr>"
            
            fails_html = f'''
            <div style='margin-top:30px; padding-top:20px; border-top:2px dashed #cbd5e1;'>
                <div style='font-size:16px; font-weight:bold; color:#b91c1c; margin-bottom:12px;'>⚠️ Обнаружено ошибок: {len(failed_records)} (выборка: 100 последних на каждый канал)</div>
                <div style='max-height:300px; overflow-y:auto; border:1px solid #e2e8f0; border-radius:8px;'>
                    <table style='width:100%; border-collapse:collapse; font-size:13px; text-align:left;'>
                        <thead style='background:#f1f5f9; position:sticky; top:0;'>
                            <tr>
                                <th style='padding:10px 12px; color:#334155; border-bottom: 1px solid #cbd5e1;'>Канал</th>
                                <th style='padding:10px 12px; color:#334155; border-bottom: 1px solid #cbd5e1;'>Дата</th>
                                <th style='padding:10px 12px; color:#334155; border-bottom: 1px solid #cbd5e1;'>User ID</th>
                                <th style='padding:10px 12px; color:#334155; border-bottom: 1px solid #cbd5e1;'>Причина ошибки</th>
                            </tr>
                        </thead>
                        <tbody>{fails_rows}</tbody>
                    </table>
                </div>
            </div>
            '''

        if not found_any:
            communications_html = "<div style='color:#64748b; font-style:italic; padding: 10px;'>Отправок за выбранный период не найдено.</div>"

        # =====================================================================
        # 4. ОТВЯЗКА ОТ SMARTICO CORE (Собственная генерация HTML)
        # =====================================================================

        def esc(t): return str(t).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')

        # 4.1 Формируем таблицу "General Settings" (Данные уже очищены Ядром)
        general_rows = ""
        if isinstance(general_data, dict):
            for k, v in general_data.items():
                val_display = f"<a href='{v}' target='_blank' style='color:#2563eb;'>{esc(v)}</a>" if k == "Target URL" else esc(v)
                general_rows += f"<tr><td style='padding:10px 12px; border-bottom:1px solid #e2e8f0; font-weight:600; color:#475569; width:35%; background:#f8fafc;'>{esc(k)}</td><td style='padding:10px 12px; border-bottom:1px solid #e2e8f0; color:#1e293b; word-break:break-all;'>{val_display}</td></tr>"

        # 4.2 Формируем блок "Segment" (Используем чистые данные напрямую из Ядра)
        segment_html = "<i style='color:#94a3b8;'>Сегмент не задан или не найден</i>"
        
        if segment_data and isinstance(segment_data, dict):
            seg_name = segment_data.get("name", "Настройки аудитории")
            seg_url = segment_data.get("url", "#")
            inc_list = segment_data.get("state_conditions", [])
            exc_list = segment_data.get("modal_conditions", [])

            if seg_url != "#":
                seg_title = f"<a href='{seg_url}' target='_blank' style='color:#2563eb; text-decoration:none; border-bottom:1px dashed rgba(37,99,235,0.4);'>{esc(seg_name)}</a>"
            else:
                seg_title = f"⚡ {esc(seg_name)}"

            segment_html = f"<div style='font-weight:bold; color:#0f172a; margin-bottom:12px; font-size: 14px;'>{seg_title}</div>"

            if not inc_list and not exc_list:
                # Если это Chained Campaign, выводим специальную заглушку
                if "Trigger:" in seg_name:
                    segment_html += "<div style='color:#059669; font-size:13px; padding: 10px; background: #dcfce7; border-radius: 6px; border: 1px solid #86efac; font-weight: bold;'>🔗 Запускается по триггеру (Chained Campaign)</div>"
                else:
                    segment_html += "<div style='color:#64748b; font-style:italic; font-size:13px; padding: 10px; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0;'>Условия не заданы (All Users)</div>"
            else:
                if inc_list:
                    lis = "".join([f"<li style='margin-bottom:6px;'>{esc(line)}</li>" for line in inc_list])
                    segment_html += f'''
                    <details style='margin-bottom: 8px; background:#fdfefe; border: 1px solid #bbf7d0 !important; border-radius:6px; box-shadow:none !important;' open>
                        <summary style='cursor: pointer; font-weight: bold; color: #166534 !important; font-size: 13px; background:#f0fdf4 !important; padding:8px 12px !important; border-radius:6px; outline:none; list-style:none;'>✅ Настройки сегмента ({len(inc_list)})</summary>
                        <div style='padding:10px 12px 10px 24px !important; border-top: 1px solid #bbf7d0 !important; background: transparent !important;'>
                            <ul style='margin: 0 !important; padding: 0; font-size: 12px; font-family: ui-monospace, monospace; color:#334155; list-style-type: disc;'>{lis}</ul>
                        </div>
                    </details>
                    '''
                if exc_list:
                    lis = "".join([f"<li style='margin-bottom:6px;'>{esc(line)}</li>" for line in exc_list])
                    segment_html += f'''
                    <details style='margin-bottom: 8px; background:#fdfefe; border: 1px solid #fde68a !important; border-radius:6px; box-shadow:none !important;' open>
                        <summary style='cursor: pointer; font-weight: bold; color: #92400e !important; font-size: 13px; background:#fffbeb !important; padding:8px 12px !important; border-radius:6px; outline:none; list-style:none;'>🚫 Исключения ({len(exc_list)})</summary>
                        <div style='padding:10px 12px 10px 24px !important; border-top: 1px solid #fde68a !important; background: transparent !important;'>
                            <ul style='margin: 0 !important; padding: 0; font-size: 12px; font-family: ui-monospace, monospace; color:#334155; list-style-type: disc;'>{lis}</ul>
                        </div>
                    </details>
                    '''

        # 4.3 Статус Контекста
        # 🚨 Изменили "FOUND" на "✅", так как теперь ядро отдает само значение тега
        if "✅" in str(context_status):
            ctx_badge = f"<span style='background:#dcfce7; color:#166534; padding:2px 8px; border-radius:12px; font-size:12px; font-weight:bold; border:1px solid #86efac;'>{esc(context_status)}</span>"
        else:
            ctx_badge = f"<span style='background:#fef2f2; color:#991b1b; padding:2px 8px; border-radius:12px; font-size:12px; font-weight:bold; border:1px solid #fca5a5;'>{esc(context_status)}</span>"

        # 4.4 СОБИРАЕМ ИТОГОВЫЙ БЛОК КАМПАНИИ (Все 3 главных блока ЗАКРЫТЫ по умолчанию)
        campaign_block_html = f'''
        <div style="font-family: system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; gap: 20px;">
            
            <details style="background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                <summary style="padding: 16px 20px; font-size: 16px; font-weight: bold; background: #f8fafc; border-bottom: 1px solid #cbd5e1; cursor: pointer; border-radius: 8px 8px 0 0; list-style: none; display: flex; align-items: center; gap: 10px;">
                    📍 General, Segments & Context 
                    <span style="font-size: 13px; font-weight: normal; color: #64748b; margin-left: auto;">Нажмите, чтобы развернуть</span>
                </summary>
                <div style="padding: 20px; display: flex; flex-wrap: wrap; gap: 24px;">
                    <div style="flex: 1; min-width: 320px;">
                        <h3 style="margin-top:0; color:#0f172a; font-size:15px; border-bottom:2px solid #3b82f6; padding-bottom:8px; margin-bottom:12px;">⚙️ Основные настройки</h3>
                        <div style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                            <table style="width:100%; border-collapse: collapse; font-size: 13px; text-align: left;">
                                <tbody>{general_rows}</tbody>
                            </table>
                        </div>
                        <div style="margin-top: 15px; background: #f8fafc; border-left: 4px solid #3b82f6; padding: 12px; border-radius: 4px; font-size: 13px; border: 1px solid #e2e8f0;">
                            <b>🔗 campaign tag:</b> {ctx_badge}
                        </div>
                    </div>
                    
                    <div style="flex: 1; min-width: 320px;">
                        <h3 style="margin-top:0; color:#0f172a; font-size:15px; border-bottom:2px solid #10b981; padding-bottom:8px; margin-bottom:12px;">👥 Аудитория (Segment)</h3>
                        {segment_html}
                    </div>
                </div>
            </details>

            <details style="background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                <summary style="padding: 16px 20px; font-size: 16px; font-weight: bold; background: #f8fafc; border-bottom: 1px solid #cbd5e1; cursor: pointer; border-radius: 8px 8px 0 0; list-style: none; display: flex; align-items: center; gap: 10px;">
                    📬 Анализ отправок: Примеры & Ошибки
                    <span style="font-size: 13px; font-weight: normal; color: #64748b; margin-left: auto;">Нажмите, чтобы развернуть</span>
                </summary>
                <div style="padding: 20px;">
                    <div style="margin-bottom: 15px; font-size:14px; color:#475569;">
                        Случайные примеры отправок (выбрано из последних 100 логов по каждому каналу):
                    </div>
                    {communications_html}
                    {fails_html}
                </div>
            </details>

            <details style="background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                <summary style="padding: 16px 20px; font-size: 16px; font-weight: bold; background: #f8fafc; border-bottom: 1px solid #cbd5e1; cursor: pointer; border-radius: 8px 8px 0 0; list-style: none; display: flex; align-items: center; gap: 10px;">
                    📸 Интерактивная карта (Flow Map)
                    <span style='color: #059669; font-size: 14px; margin-left: 15px; background: #dcfce7; padding: 2px 8px; border-radius: 12px;'>👥 Входов за {days_back} дн.: {total_entries}</span>
                    <span style="font-size: 13px; font-weight: normal; color: #64748b; margin-left: auto;">Нажмите, чтобы развернуть</span>
                </summary>
                <div style="padding: 0;">
                    {flow_html}
                </div>
            </details>
            
        </div>
        '''

        # Возвращаем наш чистый кастомный HTML
        browser.close()
        return campaign_block_html, camp_id

# =====================================================================
# 🖥️ СТРОИМ ПОЛЬЗОВАТЕЛЬСКИЙ ИНТЕРФЕЙС (STREAMLIT)
# =====================================================================
def run_module(cookie_manager):
    st.title("🕵️‍♂️ Массовый аудит (Monthly Report)")

    # Поле ввода URL (Многострочное)
    urls_input = st.text_area("🔗 Список ссылок на кампании (каждая с новой строки)", placeholder="https://...\nhttps://...", height=150)
    urls = [u.strip() for u in urls_input.split('\n') if u.strip()]

    # ⚡️ УМНОЕ ОПРЕДЕЛЕНИЕ ТОКЕНА ИЗ ГЛАВНОГО МЕНЮ (по первой ссылке) ⚡️
    token_input = ""
    if urls:
        env_match = re.search(r"drive(?:-(\d+))?\.smartico\.ai", urls[0])
        env_suffix = env_match.group(1) if env_match and env_match.group(1) else "2"
        env_key = f"env{env_suffix}"
        
        # Берем токен из кэша главного файла
        token_input = st.session_state.get(f"token_{env_key}", "")
        
        # Если токена нет, просим ввести и сохраняем навсегда
        if not token_input:
            st.warning(f"⚠️ Нет токена для окружения {env_key}. Пожалуйста, введите его:")
            token_input = st.text_input(f"🔑 Auth Token ({env_key})", type="password")
            if token_input:
                st.session_state[f"token_{env_key}"] = token_input
                cookie_manager.set(f"smartico_token_{env_key}", token_input, expires_at=datetime.now() + timedelta(days=30))
                st.rerun()
    
    st.markdown("---")
    st.subheader("⚙️ Настройки статистики")
    
    # Чекбокс включен по умолчанию (value=True)
    use_stats = st.checkbox("📈 Запросить статистику по юзерам", value=True)
    
    days_input = 14 # Значение по умолчанию, если чекбокс выключен
    if use_stats:
        days_input = st.number_input("Количество дней для сбора данных", min_value=1, max_value=90, value=14, step=1)

    st.markdown("---")
    
    # Проверяем, есть ли уже готовый отчет в памяти (чтобы кнопка скачивания не пропадала)
    if 'final_mass_report' not in st.session_state:
        st.session_state['final_mass_report'] = ""
        st.session_state['processed_count'] = 0

    if st.button("🚀 Запустить проверку", use_container_width=True, type="primary"):
        if not urls or not token_input:
            st.error("❌ Пожалуйста, вставьте хотя бы одну ссылку и убедитесь, что есть токен.")
            return
            
        combined_html = '<div style="background: #f8fafc; padding: 20px; font-family: sans-serif;"><h1 style="text-align:center; color:#1e293b; margin-bottom: 30px;">Сводный отчет по аудиту</h1>'
        progress_bar = st.progress(0)
        
        # Запускаем цикл по всем ссылкам
        for i, current_url in enumerate(urls):
            with st.spinner(f"⏳ Обработка {i+1} из {len(urls)}: {current_url}"):
                try:
                    report_html, campaign_id = run_standalone_audit(
                        url=current_url, 
                        token=token_input, 
                        use_live_view=use_stats, 
                        days_back=days_input if use_stats else 0
                    )
                    
                    # Оборачиваем каждую кампанию в визуальный блок-разделитель
                    combined_html += f'''
                    <div style="border: 4px solid #cbd5e1; border-top: 8px solid #3b82f6; border-radius: 12px; margin-bottom: 40px; background: white; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                        <div style="background: #f1f5f9; padding: 15px 20px; border-bottom: 1px solid #cbd5e1;">
                            <h2 style="margin: 0; color: #0f172a; font-size: 20px;">📌 Кампания #{campaign_id}</h2>
                            <a href="{current_url}" target="_blank" style="color: #3b82f6; font-size: 13px;">{current_url}</a>
                        </div>
                        <div style="padding: 20px;">
                            {report_html}
                        </div>
                    </div>
                    '''
                except Exception as e:
                    st.error(f"❌ Ошибка при обработке {current_url}: {e}")
            
            # Обновляем прогресс-бар
            progress_bar.progress((i + 1) / len(urls))
            
        combined_html += '</div>'
        
        # Сохраняем итоговый склеенный HTML в сессию
        st.session_state['final_mass_report'] = combined_html
        st.session_state['processed_count'] = len(urls)

    # ⚡️ ВЫВОД КНОПКИ СКАЧИВАНИЯ (Вне кнопки запуска) ⚡️
    if st.session_state['final_mass_report']:
        st.success(f"✅ Успешно сгенерирован сводный отчет ({st.session_state['processed_count']} камп.)!")
        
        st.download_button(
            label=f"⬇️ Скачать сводный отчет",
            data=st.session_state['final_mass_report'],
            file_name=f"Mass_Audit_{datetime.now().strftime('%Y%m%d_%H%M')}.html",
            mime="text/html",
            type="primary",
            use_container_width=True
        )

# Запуск происходит через главный файл app.py