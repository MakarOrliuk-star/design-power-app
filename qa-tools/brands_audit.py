import streamlit as st
import requests
import json
import re
import html

class BrandAuditorEngine:
    def __init__(self, brand_id, boapi_host, auth_token):
        self.brand_id = str(brand_id)
        self.boapi_host = boapi_host
        self.auth_token = auth_token
        self.headers = {
            "accept": "application/json",
            "authorization": self.auth_token,
            "active_label_id": self.brand_id,
            "content-type": "application/json",
            # 👇 МАСКИРУЕМ СЕРВЕР ПОД ОБЫЧНЫЙ БРАУЗЕР
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }

    def get_campaign_metadata(self, campaign_id, is_popup):
        camp_type = "j_audience_head" if is_popup else "j_audience_scheduled"
        url = f"https://{self.boapi_host}/api/{camp_type}/{campaign_id}"
        try:
            res = requests.get(url, params={"lbl": self.brand_id}, headers=self.headers, timeout=15)
            if res.status_code in [401, 403]:
                return "UNAUTHORIZED"
                
            if res.ok:
                data = res.json()
                meta = data[0] if isinstance(data, list) and len(data) > 0 else data
                return meta if isinstance(meta, dict) else {}
            else:
                st.error(f"Ошибка API (ID {campaign_id}): {res.status_code} - {res.text[:200]}")
        except Exception as e:
            st.error(f"Критическая ошибка запроса: {e}")
        return {}

    def normalize_label_name(self, raw_label):
        if not raw_label: 
            return ""
        text = raw_label.lower()
        text = text.replace('{{', '').replace('}}', '').strip()
        if text.startswith('label.'):
            text = text.replace('label.', '', 1)
            
        text = re.sub(r'[^\w\s]', ' ', text)
        text = re.sub(r'\s+', '_', text.strip())
        return text

    def get_bulk_label_values(self, label_names, target_condition):
        results = {}
        target_cond_lower = target_condition.lower()
        
        with requests.Session() as session:
            session.headers.update(self.headers)
            
            for original_name in label_names:
                search_target = self.normalize_label_name(original_name)
                if not search_target: 
                    continue
                
                url = f"https://{self.boapi_host}/api/labels_tags"
                
                def search_api(target_str, orig_str):
                    filters = [
                        {"tag_name": orig_str},
                        {"tag_name": target_str},
                        {"q": target_str},
                        {"name": target_str}
                    ]
                    matches = []
                    for f in filters:
                        params = {"filter": json.dumps(f), "range": "[0,500]"}
                        res = session.get(url, params=params, timeout=5)
                        
                        if res.status_code in [401, 403]: 
                            return "UNAUTHORIZED"
                        
                        if res.ok:
                            raw_data = res.json()
                            tags = raw_data.get("result", raw_data) if isinstance(raw_data, dict) else raw_data
                            if isinstance(tags, list):
                                for t in tags:
                                    n = self.normalize_label_name(str(t.get("name", "")))
                                    tn = self.normalize_label_name(str(t.get("tag_name", "")))
                                    k = self.normalize_label_name(str(t.get("key", "")))
                                    if target_str in [n, tn, k] or orig_str.lower() in [n, tn, k]:
                                        if t not in matches:
                                            matches.append(t)
                        if matches: 
                            break
                    return matches
                
                try:
                    exact_matches = search_api(search_target, original_name)
                    if exact_matches == "UNAUTHORIZED": 
                        return "UNAUTHORIZED"
                    
                    if not exact_matches:
                        param_match = re.search(r'([a-zA-Z_]+)_?\d+$', search_target)
                        if param_match:
                            base_target = param_match.group(1).rstrip('_')
                            exact_matches = search_api(base_target, base_target)
                            if exact_matches == "UNAUTHORIZED": 
                                return "UNAUTHORIZED"

                    if not exact_matches:
                        results[original_name] = "❌ Лейбл не найден в БД"
                        continue
                        
                    exact_matches.sort(key=lambda x: -x.get("id", 0))
                    
                    matched_val = None
                    fallback_all_users_val = None
                    
                    for t in exact_matches:
                        cond = str(t.get("conditions_readable", "")).lower()
                        if target_cond_lower in cond:
                            matched_val = t.get("tag_value", "")
                            break
                        if cond in ["", "all users", "not set", "none"]:
                            if fallback_all_users_val is None:
                                fallback_all_users_val = t.get("tag_value", "")
                                
                    if matched_val is not None:
                        results[original_name] = matched_val
                        continue
                        
                    for t in exact_matches:
                        if matched_val is not None: 
                            break
                        if int(t.get("variations_count", 0)) == 0: 
                            continue
                        
                        v_url = f"https://{self.boapi_host}/api/labels_tags_variation"
                        v_params = {"filter": json.dumps({"tag_id": int(t["id"])}), "range": "[0,100]"}
                        v_res = session.get(v_url, params=v_params, timeout=5)
                        
                        if v_res.status_code in [401, 403]: 
                            return "UNAUTHORIZED"
                        
                        if v_res.ok:
                            variations = v_res.json()
                            if isinstance(variations, dict): 
                                variations = variations.get("result", [])
                            if isinstance(variations, list):
                                for v in variations:
                                    v_cond = str(v.get("variation_condition_readable") or v.get("conditions_readable") or "").lower()
                                    if target_cond_lower in v_cond:
                                        matched_val = v.get("tag_value", "")
                                        break
                                        
                    if matched_val is not None:
                        results[original_name] = matched_val
                    elif fallback_all_users_val is not None:
                        results[original_name] = fallback_all_users_val + " <br><span style='color:#94a3b8; font-size:10px;'>(Default / All Users)</span>"
                    else:
                        results[original_name] = "⚠️ Вариация не найдена"
                        
                except Exception as e:
                    results[original_name] = f"❌ Ошибка: {str(e)}"
                    
        return results

def resolve_short_url(raw_val):
    """
    Раскручивает шорт-линк до финального URL (проходя все редиректы)
    """
    # Очищаем от HTML заглушек (на случай дефолтного All Users)
    url = str(raw_val).split(" <br>")[0].strip()
    
    if not url: 
        return "⚠️ Пусто"
        
    # Если в строке нет точки (домена), это точно не ссылка
    if "." not in url:
        return "⚠️ Не похоже на ссылку"
        
    if not url.startswith('http'):
        url = 'https://' + url
        
    try:
        # Притворяемся обычным браузером, чтобы Rebrandly не заблокировал
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        # Используем stream=True, чтобы не скачивать весь HTML-код тяжелой страницы (экономит время)
        res = requests.get(url, allow_redirects=True, headers=headers, timeout=10, stream=True)
        return res.url
    except Exception as e:
        return f"❌ Ошибка соединения: {str(e)}"

def parse_input_to_campaigns(raw_input):
    found = []
    urls = re.findall(r'(?:https?://)?(?:[a-zA-Z0-9-]+\.)*smartico\.ai/[^\s<>"]+', raw_input)
    
    for url in urls:
        env = "env2"
        host = "boapi.smartico.ai"
        if "drive-5" in url or "drive5" in url: env, host = "env5", "boapi5.smartico.ai"
        elif "drive-7" in url or "drive7" in url: env, host = "env7", "boapi7.smartico.ai"
        
        match = re.search(r'/(\d+)#/([^/]+)/(\d+)', url)
        if match:
            found.append({
                "env": env, 
                "host": host, 
                "brand_id": match.group(1),
                "camp_id": match.group(3), 
                "is_pop": "head" in match.group(2), 
                "url": url if url.startswith("http") else f"https://{url}"
            })
    
    seen = set()
    return [seen.add(c['camp_id']) or c for c in found if c['camp_id'] not in seen]

def parse_labels_input(raw_input):
    if '{{label.' in raw_input:
        return list(set(re.findall(r'\{\{label\.([^\}]+)\}\}', raw_input)))
    labels = re.split(r'[\n\r\t,;\s]+', raw_input)
    return list(set([l.strip() for l in labels if l.strip()]))

def search_keyword_in_dict(obj, keyword, path=""):
    kw_lower = str(keyword).lower().strip()
    matches = []
    if obj is None: return []

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
            matches.append((path, val_str))
    return matches

def highlight_text(text, keyword):
    escaped_text = html.escape(str(text))
    pattern = re.compile(f"({re.escape(keyword)})", re.IGNORECASE)
    return pattern.sub(r"<mark style='background:#fef08a; color:#000; padding:2px; border-radius:3px; font-weight:bold;'>\1</mark>", escaped_text)

def run_module(cookie_manager):
    st.header("🏷️ Brands")
    
    tab1, tab2, tab3 = st.tabs(["🗺️ Проверка кампаний", "🔠 Парсер лейблов", "🔗 Парсер шорт-линков"])
    
    default_brands = {"env2": "2828", "env5": "20115", "env7": "28111"}
    host_map = {"env2": "boapi.smartico.ai", "env5": "boapi5.smartico.ai", "env7": "boapi7.smartico.ai"}

    # ==========================================
    # ВКАЛДКА 1: ПОИСК ПО НАСТРОЙКАМ КАМПАНИЙ
    # ==========================================
    with tab1:
        col1, col2 = st.columns([0.7, 0.3])
        with col1:
            raw_data = st.text_area("📋 Список ссылок на кампании (каждая с новой строки):", height=150, key="camp_input")
        with col2:
            keyword = st.text_input("🔍 Название бренда:", placeholder="Например: Spinstein", key="camp_kw")
            start_btn = st.button("🚀 Начать поиск", use_container_width=True, key="camp_btn")

        if start_btn and raw_data and keyword:
            campaigns = parse_input_to_campaigns(raw_data)
            
            if not campaigns:
                st.error("❌ Ссылки Smartico не обнаружены.")
            else:
                st.info(f"🔎 Анализируем {len(campaigns)} объектов...")
                progress = st.progress(0)
                expired_envs = set()

                for idx, camp in enumerate(campaigns):
                    env = camp['env']
                    if env in expired_envs:
                        progress.progress((idx + 1) / len(campaigns))
                        continue

                    token = st.session_state.get(f"token_{env}", "")
                    if not token:
                        st.warning(f"⚠️ Нет авторизации для {env.upper()} (пропущена кампания ID: {camp['camp_id']})")
                        continue
                        
                    engine = BrandAuditorEngine(camp["brand_id"], camp["host"], token)
                    meta = engine.get_campaign_metadata(camp["camp_id"], camp["is_pop"])
                    
                    if meta == "UNAUTHORIZED":
                        st.error(f"❌ Токен авторизации для {env.upper()} протух. Пожалуйста, перезайдите в систему (крестик в левом меню).")
                        expired_envs.add(env)
                        progress.progress((idx + 1) / len(campaigns))
                        continue
                        
                    if meta:
                        matches = search_keyword_in_dict(meta, keyword)
                        unique_matches = []
                        seen_values = set()
                        
                        for path, val in matches:
                            norm_val = " ".join(str(val).split())
                            if norm_val not in seen_values:
                                seen_values.add(norm_val)
                                unique_matches.append((path, val))
                        
                        status_icon = "🎯" if unique_matches else "⚪"
                        camp_name = meta.get('audience_name', meta.get('name', 'Unnamed'))
                        
                        st.markdown("---")
                        st.markdown(f"#### {status_icon} {camp_name} <span style='color:#64748b; font-size:14px;'>(ID: {camp['camp_id']})</span>", unsafe_allow_html=True)
                        st.markdown(f"**🔗 Ссылка:** <a href='{camp['url']}' target='_blank'>Открыть кампанию в Smartico ↗</a>", unsafe_allow_html=True)
                        
                        if unique_matches:
                            for path, val in unique_matches:
                                st.markdown(f"<div style='margin-top:10px; background:#f8fafc; padding:12px; border-radius:6px; border:1px solid #e2e8f0; border-left:4px solid #10b981; font-family:monospace; font-size:13px; color:#334155; line-height:1.6; word-break:break-word;'>{highlight_text(val, keyword)}</div>", unsafe_allow_html=True)
                        else:
                            st.markdown("<div style='margin-top:10px; color:#94a3b8; font-style:italic;'>Ключевое слово в настройках сегмента не найдено.</div>", unsafe_allow_html=True)
                    
                    progress.progress((idx + 1) / len(campaigns))
                    
                st.success("✅ Анализ завершен!")

    # ==========================================
    # ВКАЛДКА 2: МАССОВЫЙ ПАРСЕР ЛЕЙБЛОВ
    # ==========================================
    with tab2:
        st.markdown("Извлечение значений лейблов по заданному условию вариации.")
        c1, c2 = st.columns([0.3, 0.7])
        with c1:
            lbl_env = st.selectbox("Окружение:", ["env2", "env5", "env7"], key="lbl_env_tab2")
        with c2:
            lbl_keyword = st.text_input("🔍 Бренд (ключ вариации):", placeholder="Spinstein", key="lbl_kw_tab2")
            
        lbl_brand = default_brands[lbl_env]
        lbl_raw_data = st.text_area("📋 Вставьте список лейблов:", height=200, key="lbl_text_tab2")
        lbl_btn = st.button("🚀 Извлечь значения лейблов", use_container_width=True, key="lbl_btn_tab2")
        
        if lbl_btn and lbl_raw_data and lbl_keyword:
            parsed_labels = parse_labels_input(lbl_raw_data)
            if not parsed_labels:
                st.error("❌ Лейблы не распознаны.")
                st.stop()
                
            token = st.session_state.get(f"token_{lbl_env}", "")
            if not token:
                st.error(f"❌ Нет авторизации для {lbl_env.upper()}. Перезайдите в систему.")
                st.stop()
                
            st.info(f"⏳ Скачиваем {len(parsed_labels)} лейблов...")
            engine = BrandAuditorEngine(lbl_brand, host_map[lbl_env], token)
            results = engine.get_bulk_label_values(parsed_labels, lbl_keyword)
            
            if results == "UNAUTHORIZED":
                st.error("❌ Токен авторизации протух.")
                st.stop()
                
            st.success("✅ Готово!")
            
            html_table = "<table style='width:100%; border-collapse: collapse; font-family: monospace; font-size: 13px; text-align: left;'><tr style='background: #f1f5f9;'><th style='padding: 10px; border: 1px solid #cbd5e1; width: 40%;'>Имя Лейбла</th><th style='padding: 10px; border: 1px solid #cbd5e1;'>Значение (для: " + html.escape(lbl_keyword) + ")</th></tr>"
            
            for lbl_name in parsed_labels:
                val = results.get(lbl_name, "❌ Ошибка загрузки")
                if "❌" in val or "⚠️" in val:
                    val_display = f"<span style='color: #b91c1c; font-weight: bold;'>{val}</span>"
                    bg_color = "#fef2f2"
                else:
                    val_display = html.escape(val).replace('\n', '<br>')
                    bg_color = "#ffffff"
                    
                html_table += f"<tr style='background: {bg_color};'><td style='padding: 10px; border: 1px solid #cbd5e1;'><b>{html.escape(lbl_name)}</b></td><td style='padding: 10px; border: 1px solid #cbd5e1;'>{val_display}</td></tr>"
            
            html_table += "</table>"
            st.markdown(html_table, unsafe_allow_html=True)

    # ==========================================
    # ВКАЛДКА 3: ПРОВЕРКА ШОРТ-ЛИНКОВ
    # ==========================================
    with tab3:
        st.markdown("Парсит лейблы, достает шорт-линки и раскрывает их до финального URL.")
        
        c1, c2 = st.columns([0.3, 0.7])
        with c1:
            link_env = st.selectbox("Окружение:", ["env2", "env5", "env7"], key="link_env_tab3")
        with c2:
            link_keyword = st.text_input("🔍 Бренд (ключ вариации):", placeholder="Spinstein", key="link_kw_tab3")
            
        link_brand = default_brands[link_env]
        link_raw_data = st.text_area(
            "📋 Список лейблов, либо шорт-линков:", 
            height=200, 
            placeholder="crm2_brand_link\ncrm2_brand_link_sms",
            key="link_text_tab3"
        )
        
        link_btn = st.button("🚀 Проверить шорт-линки", use_container_width=True, key="link_btn_tab3")
        
        if link_btn and link_raw_data and link_keyword:
            parsed_items = parse_labels_input(link_raw_data)
            if not parsed_items:
                st.error("❌ Данные не распознаны.")
                st.stop()
                
            token = st.session_state.get(f"token_{link_env}", "")
            if not token:
                st.error(f"❌ Нет авторизации для {link_env.upper()}. Перезайдите в систему.")
                st.stop()
                
            labels_to_fetch = []
            resolved_links = {}

            # Разделяем: что идем искать в Smartico, а что проверяем сразу
            for item in parsed_items:
                if "." in item:
                    # Это прямая ссылка
                    resolved_links[item] = {"short": item, "full": "", "status": "ok"}
                else:
                    # Это имя лейбла
                    labels_to_fetch.append(item)
                    
            results = {}
            if labels_to_fetch:
                st.info(f"⏳ Шаг 1: Скачиваем настройки {len(labels_to_fetch)} лейблов...")
                engine = BrandAuditorEngine(link_brand, host_map[link_env], token)
                results = engine.get_bulk_label_values(labels_to_fetch, link_keyword)
                
                if results == "UNAUTHORIZED":
                    st.error("❌ Токен авторизации протух.")
                    st.stop()

            # Добавляем результаты парсинга к общему пулу ссылок
            for lbl_name, val in results.items():
                if "❌" in val or "⚠️" in val:
                    resolved_links[lbl_name] = {"short": val, "full": "", "status": "error"}
                else:
                    resolved_links[lbl_name] = {"short": val, "full": "", "status": "ok"}

            st.info("🔗 Шаг 2: Раскручиваем все ссылки (проходим редиректы)...")
            progress = st.progress(0)
            
            total_links = len(resolved_links)
            for idx, (name, data) in enumerate(resolved_links.items()):
                if data["status"] == "ok":
                    full_url = resolve_short_url(data["short"])
                    data["full"] = full_url
                    if "❌" in full_url or "⚠️" in full_url:
                        data["status"] = "error"
                        
                progress.progress((idx + 1) / total_links)
                
            st.success("✅ Проверка завершена!")
            
            # Отрисовка таблицы с результатами редиректов
            html_table = "<table style='width:100%; border-collapse: collapse; font-family: monospace; font-size: 13px; text-align: left;'>"
            html_table += "<tr style='background: #f1f5f9;'><th style='padding: 10px; border: 1px solid #cbd5e1; width: 25%;'>Имя Лейбла / Ссылка</th><th style='padding: 10px; border: 1px solid #cbd5e1; width: 25%;'>Short-link</th><th style='padding: 10px; border: 1px solid #cbd5e1; width: 50%;'>Финальный URL</th></tr>"
            
            for item_name in parsed_items:
                data = resolved_links.get(item_name, {})
                short_val = data.get("short", "")
                full_val = data.get("full", "")
                
                if data.get("status") == "error":
                    short_display = f"<span style='color: #b91c1c; font-weight: bold;'>{short_val}</span>"
                    full_display = f"<span style='color: #b91c1c;'>{full_val}</span>"
                    bg_color = "#fef2f2"
                else:
                    clean_short = str(short_val).split(" <br>")[0]
                    short_display = f"<a href='{clean_short if clean_short.startswith('http') else 'https://'+clean_short}' target='_blank' style='color: #3b82f6;'>{html.escape(clean_short)}</a>"
                    
                    full_display = html.escape(full_val)
                    if "?" in full_display:
                        parts = full_display.split("?", 1)
                        full_display = f"<a href='{html.escape(full_val)}' target='_blank' style='color: #059669; text-decoration: none;'>{parts[0]}<span style='color: #d97706; font-weight: bold;'>?{parts[1]}</span></a>"
                    else:
                        full_display = f"<a href='{html.escape(full_val)}' target='_blank' style='color: #059669; text-decoration: none;'>{full_display}</a>"
                        
                    bg_color = "#ffffff"
                    
                html_table += f"<tr style='background: {bg_color};'><td style='padding: 10px; border: 1px solid #cbd5e1;'><b>{html.escape(item_name)}</b></td><td style='padding: 10px; border: 1px solid #cbd5e1; word-break: break-all;'>{short_display}</td><td style='padding: 10px; border: 1px solid #cbd5e1; word-break: break-all;'>{full_display}</td></tr>"
            
            html_table += "</table>"
            st.markdown(html_table, unsafe_allow_html=True)
