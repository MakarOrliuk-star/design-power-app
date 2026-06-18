import json
import re
import base64
import time
import requests
from collections import defaultdict, Counter
from datetime import datetime, timedelta



class SmarticoCore:
    def __init__(self, playwright_context, auth_token, brand_id, boapi_host, drive_host):
        self.ctx = playwright_context
        self.auth_token = auth_token
        self.brand_id = str(brand_id)
        self.boapi_host = boapi_host
        self.drive_host = drive_host
        

        self.headers = {
            "accept": "application/json",
            "authorization": self.auth_token,
            "active_label_id": self.brand_id,
            "content-type": "application/json"
        }
        self.enum_cache = {}
        
        
        self.IGNORED_LABELS = {
            "{{label.text_block_3}}", "{{label.text_block_2}}", "{{label.text_block_1}}", 
            "{{label.tnc_title}}", 
            "{{label.highlight_font}}", "{{label.highlight_font_end}}", "{{label.header2}}", 
            "{{label.grey_block}}", "{{label.empty_space_preheader}}", "{{label.crm2_code_color}}", 
            "{{label.deposit_now_button}}", "{{label.button_block_2}}", "{{label.button_block_1}}", 
            "{{label.background_row}}", "{{label.1new_mail_footer_line2}}", 
            "{{label.1new_mail_footer_line1}}", "{{label.new_mail_footer_line3}}",
            "{{label.new_mail_footer_line4}}", "{{label.new_mail_footer_line5}}", 
            "{{label.grey_block_with_img_button_1}}", "{{label.new_button_block_1}}",
            "{{label.grey_block_with_img_button_2}}", "{{label.new_button_block_2}}",
            "{{label.up_to_word_small_translation}}", "{{label.free_spins_word_translation}}",
            "{{label.1new_small_leftblock3}}", "{{label.new_small_leftblock1}}",
            "{{label.new_small_leftblock2}}", "{{label.claim_now_button}}", "{{label.up_to_translation}}",
            "{{label.header}}", "{{label.mail_footer_line3}}", "{{label.mail_footer_line2}}", "{{label.mail_footer_line1}}",
            "{{label.mail_footer_line5}}", "{{label.mail_footer_line4}}", "{{label.free_spins_title}}",
            "{{label.start_now_button}}", "{{label.opt_in_button}}", "{{label.play_now_button}}", "{{label.text_block_1_radius}}",
            "{{label.user_first_name}}", "{{label.button_text_color_compositor}}", "{{label.compositor_tracking_link}}", 
            "{{label.crm2_brand_color_compositor}}", "{{label.crm2_button_color_compositor}}", "{{label.crm2_row_color_compositor}}",
            "{{label.free_word_translation}}", "{{label.spins_word_translation}}", "{{label.up_to_word_translation}}",
            "{{label.popup_highlight_color}}", "{{label.crm2_brand_link}}", "{{label.crm2_brand_link_bonus_tc}}",
            "{{label.logo_push}}", "{{label.crm2_brand_color}}", "{{label.li_terms_crm2}}", "{{forget_password_img_test_2}}",
            "{{bell_icon_header2}}", "{{avatar_header2}}", "{{header2_marketing_test_link_2}}", "{{valign}}",
            "{{bg_color}}", "{{forget_password_img_test}}", "{{all_emails_utm_logo}}", "{{label.js_today_plus_0_days}}",
            "{{claim_button}}", "{{label.promocode}}"
        }

        self.IGNORED_WEBHOOK_DEFAULTS = {
            "{{label.webhook_title}}", "{{label.webhook_text}}", "{{label.webhook_image}}",
            "{{label.webhook_link}}", "{{label.webhook_end}}", 
            "{{label.webhook_data_1}}", "{{label.webhook_data_2}}", 
            "{{label.webhook_data_3}}", "{{label.webhook_data_4}}", "{{label.webhook_data_5}}"
        }
        
        self.ALL_IGNORED_LABELS = self.IGNORED_LABELS.union(self.IGNORED_WEBHOOK_DEFAULTS)

        self.PROP_TO_ENUM_ID = {
            "state.user_country": 11,
            "state.core_user_last_login_country": 70,
            "state.scartesu_user_tags": 938,
        }

        self.FLAGS = {
            "EN": "🇬🇧", "RO": "🇷🇴", "BG": "🇧🇬", "CS": "🇨🇿", "DE": "🇩🇪",
            "FR": "🇫🇷", "EL": "🇬🇷", "HU": "🇭🇺", "IT": "🇮🇹", "NO": "🇳🇴",
            "PL": "🇵🇱", "PT": "🇵🇹", "BR": "🇧🇷", "SK": "🇸🇰", "SL": "🇸🇮", 
            "ES": "🇪🇸", "MX": "🇲🇽", "TR": "🇹🇷", "DA": "🇩🇰", "KO": "🇰🇷", 
            "FI": "🇫🇮", "HR": "🇭🇷", "SR": "🇷🇸", "MK": "🇲🇰", "SQ": "🇦🇱", 
            "BS": "🇧🇦"
        }

        self.TRASH_STRINGS = [
            "{{label.li_terms_crm2}}",
            "</font></p></li>",
            "</font></a>.</font></p></li>",
            '" style="color:{{label.crm2_brand_color}}; text-decoration:none"><font style="font-size:10px;">',
            '{{label.li_terms_crm2}}<a href="', "</font></a>", '<a href="', 
        ]

        self.KNOWN_LABEL_ALIASES = {
            "bns_2": "bonus_label_2",
        }
    
    def guess_label_category(self, label_name):
        """Определяет тип лейбла по ключевым словам в его названии"""
        name = label_name.lower().replace("{{label.", "").replace("}}", "")
        
        stop_words = ["preheader", "h1", "h2", "h3", "greeting", "content", "subject", "text", "img", "image", "button", "link", "url", "icon", "sms", "push", "popup", "pwa"]
        if any(word in name for word in stop_words):
            return None, None
            
        if "code" in name: 
            return "promocode", "Promo Code"
            
        if "end" in name and "date" in name: 
            return "end_date", "End Date"
            
        if "wager" in name or "rollover" in name: 
            return "wager", "Wager"
            
        if "percent" in name or "pct" in name:
            return "bonus_percent", "Bonus Percentage"
            
       
        if "dep" in name and "amount" in name: 
            return "min_dep", "Deposit Amount"
            
       
        if "bonus" in name and "amount" in name: 
            return "bonus_amount", "Bonus Amount"
            
        return None, None

    def validate_offer_value(self, label_type, label_value, expected_data):
        """Checks labels based on the parsed sheet"""
        if not expected_data or not expected_data.get("offers") or not label_value:
            return None, []
            
        val_str = str(label_value).upper()
        expected_vals = set()
        
        for offer in expected_data["offers"]:
            if label_type == "wager" and offer.get("wager"): expected_vals.add(str(offer["wager"]))
            elif label_type == "promocode" and offer.get("promocode"): expected_vals.add(str(offer["promocode"]).upper())
            
            if label_type == "min_dep" and offer.get("min_dep"): expected_vals.add(str(offer["min_dep"]))
            elif label_type == "bonus_percent" and offer.get("bonus_percent"): expected_vals.add(str(offer["bonus_percent"]))
            elif label_type == "bonus_amount" and offer.get("max_bonus"): expected_vals.add(str(offer["max_bonus"]))
            
            if "ladder_steps" in offer:
                for step in offer["ladder_steps"]:
                    if label_type == "min_dep" and step.get("min_dep"): expected_vals.add(str(step["min_dep"]))
                    elif label_type == "bonus_percent" and step.get("bonus_percent"): expected_vals.add(str(step["bonus_percent"]))
                    elif label_type == "bonus_amount" and step.get("max_bonus"): expected_vals.add(str(step["max_bonus"]))
            
        if not expected_vals: 
            return None, [] 
        
       
        for ev in expected_vals:
            if re.search(r'(?<![A-Za-z0-9])' + re.escape(ev) + r'(?![A-Za-z0-9])', val_str):
                return True, [ev] 
                
        return False, list(expected_vals)

    def is_ignored_label(self, lbl):
       
        lbl_lower = lbl.lower()
      
        if lbl in self.ALL_IGNORED_LABELS:
            return True
        return False   
    
    def inject_flags(self, cond_str):
        """flag emojis"""
        if not cond_str: return "Default"
        if "language" in cond_str.lower():
            # 🚨 ФИКС СКОРОСТИ 1: Компилируем регулярку один раз, а не 26 раз для каждой из 10 000 вариаций!
            if not hasattr(self, '_flags_regex'):
                self._flags_regex = re.compile(r'\b(' + '|'.join(self.FLAGS.keys()) + r')\b')
            return self._flags_regex.sub(lambda m: f"{self.FLAGS[m.group(1)]} {m.group(1)}", cond_str)
        return cond_str

    def normalize_label_name(self, raw_label):
        """Нормализует сырое имя лейбла перед отправкой в API Smartico"""
        if not raw_label: 
            return ""
        text = raw_label.lower()
        
        
        text = text.replace('{{', '').replace('}}', '').strip()
        if text.startswith('label.'):
            text = text.replace('label.', '', 1)
            
        text = re.sub(r'[^\w\s]', ' ', text)
        text = re.sub(r'\s+', '_', text.strip())
        
        # Проверяем по словарю алиасов через self
        if text in self.KNOWN_LABEL_ALIASES:
            return self.KNOWN_LABEL_ALIASES[text]
            
        return text

    def validate_label_syntax(self, text, ignore_formatting_tags=False):
        """Жестко проверяет текст на синтаксис {{label.ключ}} и сортирует ошибки на критические и замечания."""
        if not text: return {"critical": [], "warning": []}

       
        text = text.replace("'{{label.highlight_font}}$1{{label.highlight_font_end}}'", "")
        text = text.replace("'{{label.highlight_font}}$1{{label.highlight_font_end}}'", "")
        text = text.replace("<font color=\"{{label.popup_highlight_color}}\"><b>$1</b></font>", "")
        text = text.replace("<font color='{{label.popup_highlight_color}}'><b>$1</b></font>", "")

        
        has_braces = '{' in text or '}' in text
        has_symbols = '#' in text or '@' in text
        has_fixed = 'fixed' in text.lower()
        
        if not has_braces and not has_fixed:
            if ignore_formatting_tags or not has_symbols:
                return {"critical": [], "warning": []}

        criticals = set()
        warnings = set()

        clean_for_symbols = text.replace("// 🔹 Replace any #…# with HTML highlight", "")
        clean_for_symbols = clean_for_symbols.replace("// 🔹 Replace any @…@ with HTML highlight", "")
        clean_for_symbols = re.sub(r'https?://[^\s"\'<>]+', '', clean_for_symbols)
        clean_for_symbols = clean_for_symbols.replace('/#/', '/')
        clean_for_symbols = re.sub(r'&\#[0-9a-zA-Z]+;', '', clean_for_symbols)
        
        text_without_html = re.sub(r'<[^>]+>', '', clean_for_symbols)
        
        if not ignore_formatting_tags:
           
            hash_parts = text_without_html.split('#')
            if len(hash_parts) % 2 == 0:
                criticals.add(f"Нечетное количество решеток (#): найдено {len(hash_parts)-1} шт. Тег не закрыт.")
            else:
                for i in range(1, len(hash_parts), 2):
                    content = hash_parts[i]
                    if content.startswith(' '):
                        snippet = content[:20].replace('\n', ' ') + "..." if len(content) > 20 else content.replace('\n', ' ')
                        warnings.add(f"Недопустимый пробел ПОСЛЕ открывающей решетки: «# {snippet.strip()}»")
                    if content.endswith(' '):
                        snippet = content[-20:].replace('\n', ' ') if len(content) > 20 else content.replace('\n', ' ')
                        warnings.add(f"Недопустимый пробел ПЕРЕД закрывающей решеткой: «{snippet.strip()} #»")

            # ---  Checking @ @ ---
            at_parts = text_without_html.split('@')
            if len(at_parts) % 2 == 0:
                criticals.add(f"Нечетное количество знаков @: найдено {len(at_parts)-1} шт. Тег не закрыт.")
            else:
                for i in range(1, len(at_parts), 2):
                    content = at_parts[i]
                    if content.startswith(' '):
                        snippet = content[:20].replace('\n', ' ') + "..." if len(content) > 20 else content.replace('\n', ' ')
                        warnings.add(f"Недопустимый пробел ПОСЛЕ открывающей собаки: «@ {snippet.strip()}»")
                    if content.endswith(' '):
                        snippet = content[-20:].replace('\n', ' ') if len(content) > 20 else content.replace('\n', ' ')
                        warnings.add(f"Недопустимый пробел ПЕРЕД закрывающей собакой: «{snippet.strip()} @»")

        if has_braces:
            space_tags = re.findall(r'\{\{[^}]*label[^}]*\}\}', text, flags=re.IGNORECASE)
            for tag in space_tags:
                if ' ' in tag:
                    criticals.add(f"Пробелы внутри скобок недопустимы: «{tag}»")

            all_tags = re.findall(r'\{\{(.*?)\}\}', text)
            typos = {'lable', 'labl', 'labell', 'labe', 'lebel', 'labal', 'labellabel'} 
            for tag in all_tags:
                cleaned_tag = tag.strip().lower()
                first_word = cleaned_tag.split('.')[0] if '.' in cleaned_tag else cleaned_tag
                if first_word in typos:
                    criticals.add(f"Опечатка в слове label: {{{{{tag}}}}}")

            clean_text = re.sub(r'\{\{\s*label\.[^\}]+\}\}', '', text, flags=re.IGNORECASE)
            
            lower_clean = clean_text.lower()
            idx = lower_clean.find("label")
            while idx != -1:
                start_idx = max(0, idx - 10)
                end_idx = min(len(clean_text), idx + 15)
                snippet = clean_text[start_idx:end_idx].strip()
                criticals.add(f"Сломанные скобки или нет ключа (напр. de@Label3): «{snippet}»")
                idx = lower_clean.find("label", idx + 5)
                
            if '{{{' in text or '}}}' in text:
                criticals.add("Лишние фигурные скобки: найдено {{{ или }}}")

            if '{{{{}' in text or '}}}}' in text:
                criticals.add("Лишние фигурные скобки: найдено {{{{ или }}}}")
                
            if '?}' in text:
                criticals.add("Найдена опечатка: «?}» (возможно, недописанный лейбл или сломанное условие)")
                
        if has_fixed:
            criticals.add("Найдено запрещенное слово: «fixed»")
            
        return {"critical": sorted(list(criticals)), "warning": sorted(list(warnings))}

    def render_email_to_base64(self, html_content):
        if not html_content: return None
        
        # Берем context из self, а не из аргументов функции!
        page = self.ctx.new_page()
        
        full_document = f"""
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"><style>
            body, html {{ margin: 0; padding: 0; background-color: #0f172a; }} 
            img {{ max-width: 100%; height: auto; display: block; }}
            p, div, span, a, h1, h2, h3, h4, h5, h6, td, th {{ font-family: 'Arial', 'Helvetica', 'Liberation Sans', sans-serif; }}
        </style></head><body>{html_content}</body></html>
        """
        
        try:
            page.set_content(full_document, wait_until="load", timeout=10000)
            try:
                page.wait_for_load_state("networkidle", timeout=5000)
            except:
                pass
            time.sleep(1.5) 
            screenshot_bytes = page.screenshot(type="jpeg", quality=80, full_page=True)
            page.close()
            return base64.b64encode(screenshot_bytes).decode('utf-8')
        except Exception as e:
            print(f" [Сбой рендера: {e}]", end="")
            page.close()
            return None
    
    def get_flow_data_live(self, campaign_id, log_cb=None, use_live_view=False, days_back=20):
        """Скачивает ноды и связи для построения интерактивной карты.
           Умеет динамически включать/выключать Live View статистику."""
        import json
        from datetime import datetime, timedelta
        
        now = datetime.utcnow()
        past = now - timedelta(days=days_back)
        dt_from = past.strftime("%Y-%m-%dT00:00:00.000Z")
        dt_to = now.strftime("%Y-%m-%dT23:59:59.999Z")

        # 1. Формируем параметры
        if use_live_view:
            period_str = f"{past.strftime('%d.%m.%Y')} — {now.strftime('%d.%m.%Y')} ({days_back} дней)"
            if log_cb: log_cb(f"🗺️ Запрос структуры Flow Map со статистикой ({period_str})...", 20)
            
            n_params = {
                "filter": json.dumps({"r": int(campaign_id), "isLiveView": True, "dtFrom": dt_from, "dtTo": dt_to, "withArchived": False}),
                "range": json.dumps([0, 4999]), "sort": json.dumps(["id", "ASC"]), "lbl": self.brand_id
            }
            t_params = {
                "filter": json.dumps({"audience_id": int(campaign_id), "isLiveView": True}),
                "range": json.dumps([0, 4999]), "sort": json.dumps(["id", "ASC"]), "lbl": self.brand_id
            }
        else:
            period_str = "Без статистики (Live View выключен)"
            if log_cb: log_cb("🗺️ Запрос структуры Flow Map (быстрый режим без статистики)...", 20)
            
            n_params = {
                "filter": json.dumps({"r": int(campaign_id), "withArchived": False}),
                "range": json.dumps([0, 4999]), "sort": json.dumps(["id", "ASC"]), "lbl": self.brand_id
            }
            t_params = {
                "filter": json.dumps({"audience_id": int(campaign_id)}),
                "range": json.dumps([0, 4999]), "sort": json.dumps(["id", "ASC"]), "lbl": self.brand_id
            }

        req_timeout_ms = 60000 if use_live_view else 15000 
        
        res_n = self.ctx.request.get(f"https://{self.boapi_host}/api/j_audience_activity", params=n_params, headers=self.headers, timeout=req_timeout_ms)
        res_t = self.ctx.request.get(f"https://{self.boapi_host}/api/j_audience_any", params=t_params, headers=self.headers, timeout=req_timeout_ms)

        # 3. Страховка при таймауте
        if use_live_view and (not res_n.ok or not res_t.ok):
            if log_cb: log_cb("⚠️ Live View недоступен или сервер не ответил. Запрашиваю легкую карту...", 20)
            
            n_params = {
                "filter": json.dumps({"r": int(campaign_id), "withArchived": False}),
                "range": json.dumps([0, 4999]), "sort": json.dumps(["id", "ASC"]), "lbl": self.brand_id
            }
            t_params = {
                "filter": json.dumps({"audience_id": int(campaign_id)}),
                "range": json.dumps([0, 4999]), "sort": json.dumps(["id", "ASC"]), "lbl": self.brand_id
            }
            
            res_n = self.ctx.request.get(f"https://{self.boapi_host}/api/j_audience_activity", params=n_params, headers=self.headers, timeout=15000)
            res_t = self.ctx.request.get(f"https://{self.boapi_host}/api/j_audience_any", params=t_params, headers=self.headers, timeout=15000)
            period_str = "Данные без статистики (Live View Error / Timeout)"

       
        n_data, t_data = {}, {}
        try:
            if res_n.ok: n_data = res_n.json() or {}
        except: pass
        
        try:
            if res_t.ok: t_data = res_t.json() or {}
        except: pass

        # Достаем массивы
        nodes_raw = n_data.get("result", []) if isinstance(n_data, dict) else (n_data if isinstance(n_data, list) else [])
        trans_raw = t_data.get("result", []) if isinstance(t_data, dict) else (t_data if isinstance(t_data, list) else [])
        
        nodes = [x for x in (nodes_raw or []) if isinstance(x, dict)]
        trans = [x for x in (trans_raw or []) if isinstance(x, dict)]
        
        active_nodes = []
        for n in nodes:
            if n.get("is_archived") or n.get("archived") or n.get("status_id") == 6:
                continue
                
            details = n.get("details_json", "{}")
            if isinstance(details, str):
                try: details = json.loads(details)
                except: details = {}
            
            # 🚨 ФИКС: Если json.loads("null") вернул None, принудительно делаем его словарем
            if not isinstance(details, dict):
                details = {}
                
            if details.get("is_archived") or details.get("archived") or details.get("status_id") == 6:
                continue
                
            active_nodes.append(n)
            
        return active_nodes, trans, period_str

    def get_campaign_nodes(self, campaign_id):
        """Получает список всех узлов (нод) с полотна кампании"""
        url = f"https://{self.boapi_host}/api/j_audience_activity"
        query_params = {
            "filter": json.dumps({"r": int(campaign_id), "isLiveView": False, "dtFrom": None, "dtTo": None, "withArchived": False}),
            "range": json.dumps([0, 4999]),
            "sort": json.dumps(["id", "ASC"]),
            "lbl": self.brand_id
        }
        res = self.ctx.request.get(url, params=query_params, headers=self.headers)
        if not res.ok: return []
        
        data = res.json()
        nodes = data.get("result", data) if isinstance(data, dict) else data
        
        parsed_nodes = []
        if isinstance(nodes, list):
            for node in nodes:
                details = node.get("details_json", "{}")
                if isinstance(details, str):
                    try: details = json.loads(details)
                    except json.JSONDecodeError: details = {}
                elif not isinstance(details, dict):
                    details = {}
                
                # 🚨 ФИКС: Пропускаем архивные ноды при сборе контента
                if node.get("is_archived") or node.get("archived") or node.get("status_id") == 6:
                    continue
                if details.get("is_archived") or details.get("archived") or details.get("status_id") == 6:
                    continue

                aud_id = node.get("given_by_audience_id")
                if not aud_id and isinstance(details, dict):
                    aud_id = details.get("given_by_audience_id")
                
                parsed_nodes.append({
                    "id": node.get("id"),
                    "audience_id": aud_id, # Теперь здесь правильный ID стрелочки!
                    "name": node.get("activity_name", "Unnamed"),
                    "type_id": node.get("activity_type_id"),
                    "details": details
                })
        return parsed_nodes

    def get_campaign_transitions(self, campaign_id):
        """Получает условия связей (стрелочек) между нодами"""
        url = f"https://{self.boapi_host}/api/j_audience_any"
        query_params = {
            "filter": json.dumps({"audience_id": int(campaign_id), "isLiveView": False}),
            "range": json.dumps([0, 4999]),
            "sort": json.dumps(["id", "ASC"]),
            "lbl": self.brand_id
        }
        res = self.ctx.request.get(url, params=query_params, headers=self.headers)
        if not res.ok: return []
        data = res.json()
        return data.get("result", data) if isinstance(data, dict) else data

    def get_segment_full_name(self, segment_id, fallback_name):
        """Получает готовое название сегмента с юзерами через j_segment_ref"""
        if not segment_id: return fallback_name
        
        try:
            url_ref = f"https://{self.boapi_host}/api/j_segment_ref"
            query_params = {"filter": json.dumps({"id": [int(segment_id)]}), "lbl": self.brand_id}
            res = self.ctx.request.get(url_ref, params=query_params, headers=self.headers)
            
            if res.ok:
                data = res.json()
                items = data.get("result", data) if isinstance(data, dict) else data
                if isinstance(items, list) and items:
                    obj = items[0]
                    # 🚨 Забираем готовую строку "Имя / XXX users" прямо из API
                    if "segment_name" in obj and str(obj["segment_name"]).strip():
                        return str(obj["segment_name"])
                    
                    # Если вдруг поля segment_name нет, склеиваем руками
                    name = obj.get("name", fallback_name)
                    for key in ["users_count", "estimated_users", "count"]:
                        if key in obj and obj[key] is not None:
                            return f"{name} / {obj[key]} users"
                    return name
        except Exception:
            pass
            
        return fallback_name

    def get_enum_mapping(self, property_id):
        """utilizing property_id"""
        url = f"https://{self.boapi_host}/api/cj_properties_enum_ref"
        query_params = {
            "filter": json.dumps({"property_id": property_id}),
            "range": json.dumps([0, 9999]),
            "lbl": self.brand_id
        }
        try:
            res = self.ctx.request.get(url, params=query_params, headers=self.headers)
            if not res.ok: return {}
            data = res.json()
            items = data.get("result", data) if isinstance(data, dict) else data
            return {str(item["id"]): str(item.get("v") or item.get("name", item["id"])) for item in items if "id" in item}
        except:
            return {}

    def get_enum_mapping_by_ids(self, ids):
        """Universal ID search - fallback"""
        url = f"https://{self.boapi_host}/api/cj_properties_enum_ref"
        query_params = {
            "filter": json.dumps({"id": [int(x) for x in ids]}),
            "lbl": self.brand_id
        }
        try:
            res = self.ctx.request.get(url, params=query_params, headers=self.headers)
            if not res.ok: return {}
            data = res.json()
            items = data.get("result", data) if isinstance(data, dict) else data
            return {str(item["id"]): str(item.get("v") or item.get("name", item["id"])) for item in items if "id" in item}
        except:
            return {}

    def flatten_conditions(self, conds):
        """Unfolds GROUP conditions"""
        flat = []
        for c in conds:
            if c.get("p") == "GROUP":
                flat.extend(self.flatten_conditions(c.get("v", [])))
            else:
                flat.append(c)
        return flat

    def fix_empty_brackets_locally(self, cond_str, raw_conds):
        """Интеллектуальная починка пустых скобок ()"""
        if not cond_str or "()" not in cond_str:
            return cond_str
            
        flat_conds = self.flatten_conditions(raw_conds)
        used_conds = set()
        lines = cond_str.split('\n')
        fixed_lines = []

        for line in lines:
            if "()" not in line:
                fixed_lines.append(line)
                continue
            
            line_lower = line.lower()
            matched_c = None
            
            for i, c in enumerate(flat_conds):
                if i in used_conds: continue
                p = str(c.get("p", "")).lower()
                if ("tag" in p and "tag" in line_lower) or ("country" in p and "country" in line_lower):
                    matched_c = c
                    used_conds.add(i)
                    break
            
            if matched_c:
                v_str = str(matched_c.get("v", ""))
                p_str = str(matched_c.get("p", "")).lower()
                ids = re.findall(r'\d+', v_str)
                if ids:
                    if p_str in self.PROP_TO_ENUM_ID:
                        prop_id = self.PROP_TO_ENUM_ID[p_str]
                        if prop_id not in self.enum_cache:
                            self.enum_cache[prop_id] = self.get_enum_mapping(prop_id)
                        
                        mapping = self.enum_cache[prop_id]
                        names_str = ", ".join([mapping.get(str(x), f"ID:{x}") for x in ids])
                        line = line.replace("()", f"({names_str})")
                    elif "tag" in p_str:
                        names_dict = self.get_tag_names_by_ids(ids)
                        names_str = ", ".join([names_dict.get(str(x), f"ID:{x}") for x in ids])
                        line = line.replace("()", f"({names_str})")

                    else:
                        fallback_dict = self.get_enum_mapping_by_ids(ids)
                        names_str = ", ".join([fallback_dict.get(str(x), f"ID:{x}") for x in ids])
                        line = line.replace("()", f"({names_str})")

            fixed_lines.append(line)
        return '\n'.join(fixed_lines)
    
    def get_campaign_metadata(self, campaign_id, campaign_url):
        """Getting settings from (General tab)"""
        is_popup = "head" in campaign_url
        camp_type = "j_audience_head" if is_popup else "j_audience_scheduled"
        url = f"https://{self.boapi_host}/api/{camp_type}/{campaign_id}"
        res = self.ctx.request.get(url, params={"lbl": self.brand_id}, headers=self.headers)
        
        if not res.ok: return None, None
        data = res.json()
        meta = data[0] if isinstance(data, list) and len(data) > 0 else data
        
        # 🚨 ФИКС: Если API вернуло пустоту, прерываем функцию и отдаем пустые словари
        if not isinstance(meta, dict):
            return {}, {}
            
        status_map = {1: "Draft", 2: "Active", 3: "Paused", 4:"Disabled", 5: "Executed", 6: "Archived"}
        entry_map = {
            0: "Once in a lifetime of a user",
            1: "Once during open journey",
            2: "Every time conditions are met, run few at the same time",
            3: "Stop and Start"
        }
        category_map = {1: "Marketing", 133: "Marketing"}
        
        segment_id = meta.get("segment_id")
        
        # 👇 НОВАЯ ЛОГИКА ДЛЯ СВЯЗАННЫХ (CHAINED) КАМПАНИЙ 👇
        event_type = meta.get("event_type_name", "")
        if event_type == "core_start_campaign_as_chain":
            trigger_name = meta.get("event_type_uiname", "Core: start chained campaign")
            segment_info = {
                "name": f"Trigger: {trigger_name}",
                "url": "#",
                "state_conditions": [],
                "modal_conditions": []
            }
        else:
            # 🚨 СТАНДАРТНАЯ ЛОГИКА ПАРСИНГА СЕГМЕНТОВ
            state_dict = meta.get("segment_conditions_n_readable") or {}
            state_raw = state_dict.get("readable") or meta.get("segment_conditions_readable") or ""
            state_raw = str(state_raw) # Принудительно делаем строкой
            
            if "()" in state_raw:
                raw_state_conds = state_dict.get("conditions") or meta.get("segment_conditions") or []
                state_raw = self.fix_empty_brackets_locally(state_raw, raw_state_conds)
            state_conds = [c.strip() for c in state_raw.split('\n') if c.strip()] if state_raw and state_raw not in ["None", "Not set", "()", "All users"] else []
            
            # 🚨 Исключения кампании
            modal_dict = meta.get("conditions_n_readable") or {}
            modal_raw = modal_dict.get("readable") or meta.get("conditions_readable") or ""
            modal_raw = str(modal_raw) # Принудительно делаем строкой
            
            if "()" in modal_raw:
                raw_modal_conds = modal_dict.get("conditions") or meta.get("conditions") or []
                modal_raw = self.fix_empty_brackets_locally(modal_raw, raw_modal_conds)
            modal_conds = [c.strip() for c in modal_raw.split('\n') if c.strip()] if modal_raw and modal_raw not in ["None", "Not set", "()", "All users"] else []
            
            base_segment_name = meta.get("segment_name") or "All Users / Inline Rules"
            base_segment_name = self.get_segment_full_name(segment_id, base_segment_name)
            
            segment_info = {
                "name": base_segment_name,
                "url": f"https://{self.drive_host}/{self.brand_id}#/j_segment/{segment_id}" if segment_id else "#",
                "state_conditions": state_conds,
                "modal_conditions": modal_conds
            }
        # 👆 ======================================== 👆

        general_info = {
            "Тип кампании": "🗺️ Journey" if is_popup else "📅 Scheduled",
            "Target URL": campaign_url,
            "Name": meta.get("audience_name", "Unknown"),
            "Status": status_map.get(meta.get("audience_status_id"), f"ID: {meta.get('audience_status_id')}"),
            "Category": category_map.get(meta.get("campaign_category_id"), f"ID: {meta.get('campaign_category_id')}"),
            "Entry Mode": entry_map.get(meta.get("entry_mode_id"), f"ID: {meta.get('entry_mode_id')}"),
        }

        duration_ms_raw = meta.get("campaign_duration_ms")
        duration_mins_raw = meta.get("max_duration_minutes") or meta.get("max_campaign_duration_minutes")
        
        if duration_ms_raw and str(duration_ms_raw).isdigit():
            total_mins = int(duration_ms_raw) // 60000
        elif duration_mins_raw and str(duration_mins_raw).isdigit():
            total_mins = int(duration_mins_raw)
        else:
            total_mins = None

        if total_mins is not None:
            days = total_mins // 1440
            hours = (total_mins % 1440) // 60
            mins = total_mins % 60
            
            parts = []
            if days > 0: parts.append(f"{days} days" if days != 1 else f"{days} day")
            if hours > 0: parts.append(f"{hours} hours" if hours != 1 else f"{hours} hour")
            if mins > 0: parts.append(f"{mins} minutes" if mins != 1 else f"{mins} minute")
            max_duration = " ".join(parts) if parts else "< 1 minute"
        else:
            max_duration = "Unlimited / Not set"
            
        general_info["Max. campaign duration"] = max_duration

        if is_popup:
            def clean_iso(date_str):
                if not date_str or date_str == "N/A": return "N/A"
                return str(date_str).replace("T", " ").split(".")[0].replace("Z", "")

            general_info["Activity period"] = f"{clean_iso(meta.get('start_date'))} — {clean_iso(meta.get('end_date'))}"
            
            stop_ts = meta.get("global_stop_time_ts")
            if stop_ts:
                try:
                    raw_stop = datetime.fromtimestamp(stop_ts / 1000).isoformat()
                    stop_date = clean_iso(raw_stop)
                except:
                    stop_date = clean_iso(str(stop_ts))
            else:
                stop_date = "N/A"
            general_info["Stop date"] = stop_date
        else:
            config = meta.get("scheduler_config", {})
            speed = "N/A"
            if config.get("throttling"):
                speed = f"{config.get('throttling')} per {config.get('throttlingInterval', 'minute')}"
                
            # 👇 НОВЫЙ УМНЫЙ ПАРСЕР РАСПИСАНИЯ 👇
            exec_at = config.get("value", "N/A")
            
            # Smartico отдает Cron из 6 или 7 частей: Sec Min Hour DayOfMonth Month DayOfWeek
            if exec_at != "N/A" and len(exec_at.split()) >= 6:
                parts = exec_at.split()
                mins = parts[1].zfill(2)
                hours = parts[2].zfill(2)
                day_of_month = parts[3]
                days_of_week = parts[5]
                
                # 1. Еженедельное расписание (выбраны конкретные дни)
                if days_of_week not in ["*", "?"]:
                    day_map = {"MON": "Mon", "TUE": "Tue", "WED": "Wed", "THU": "Thu", "FRI": "Fri", "SAT": "Sat", "SUN": "Sun"}
                    days_fmt = ", ".join([day_map.get(d, d) for d in days_of_week.split(",")])
                    exec_at = f"Days of week: {days_fmt} at {hours}:{mins}"
                
                # 2. Ежедневное расписание с интервалом (например, */1 или 1/3)
                elif "/" in day_of_month:
                    step = day_of_month.split("/")[1]
                    if step == "1":
                        exec_at = f"Daily at {hours}:{mins}"
                    else:
                        exec_at = f"Every {step} days at {hours}:{mins}"
                
                # 3. Ежемесячное расписание (выбрано конкретное число)
                elif day_of_month not in ["*", "?"]:
                    exec_at = f"Monthly on day {day_of_month} at {hours}:{mins}"
                
                # 4. Стандартное ежедневное расписание
                else:
                    exec_at = f"Daily at {hours}:{mins}"
            # 👆 ================================ 👆

            general_info["Execute at (UTC)"] = exec_at
            general_info["Execution Speed"] = speed
            general_info["User limit per run"] = config.get("audienceLimit", "N/A")

        return general_info, segment_info

    def check_context_campaign_tag(self, campaign_id, campaign_url):
        """Проверка контекстных тегов кампании (вытягивает значение тега name)"""
        # 1. 🚨 ИСПОЛЬЗУЕМ ПРАВИЛЬНЫЙ ЭНДПОИНТ (без _tags на конце)
        url = f"https://{self.boapi_host}/api/j_audience_context_init"
        
        # 2. 🚨 ФИЛЬТРУЕМ СТРОГО ПО ID КАМПАНИИ
        query_params = {
            "filter": json.dumps({"__request_version": 0, "audience_id": int(campaign_id)}),
            "range": "[0,499]",
            "sort": '["priority","ASC"]',
            "lbl": self.brand_id
        }
        
        camp_type = "j_audience_head" if "head" in campaign_url else "j_audience_scheduled"
        
        custom_headers = self.headers.copy()
        custom_headers.update({
            "ctx-app-version": "0.1.2594",
            "referer": f"https://{self.drive_host}/",
            "origin": f"https://{self.drive_host}",
            "ctx-client-url": f"https://{self.drive_host}/{self.brand_id}#/{camp_type}/{campaign_id}/context"
        })

        res = self.ctx.request.get(url, params=query_params, headers=custom_headers)
        
        if not res.ok:
            return f"Error (API {res.status})"
            
        try:
            data = res.json()
            tags = data.get("result", data) if isinstance(data, dict) else data
            
            # 3. 🚨 ТОЧЕЧНЫЙ ПОИСК ЗНАЧЕНИЯ (Без резервного парсинга всего текста)
            if isinstance(tags, list):
                for tag in tags:
                    t_name = str(tag.get("tag_name", "")).strip().lower()
                    # Если тег называется name или campaign_name
                    if t_name in ["name", "campaign_name"]:
                        t_val = tag.get("tag_value", "")
                        # Возвращаем само значение из поля tag_value!
                        return f"✅ {t_val}" if t_val else "✅ (Пустое значение)"
                        
            return "❌ NOT FOUND"
                
        except Exception:
            return "Error (Parse)"

    def get_label_data_with_variations(self, label_name, log_cb=None):
        search_target = self.normalize_label_name(label_name)
        
        # 🚨 ФИКС ОТ ЗАВИСАНИЯ: Если после очистки имени ничего не осталось, прерываемся.
        # Иначе API попытается выгрузить ВСЮ базу лейблов, что повесит скрипт.
        if not search_target:
            return None
        
        def fetch_and_match(api_query):
            search_params = {"filter": json.dumps({"q": api_query}), "range": "[0,500]", "lbl": self.brand_id}
            res = self.ctx.request.get(f"https://{self.boapi_host}/api/labels_tags", params=search_params, headers=self.headers)
            if not res.ok: 
                if log_cb: log_cb(f"   ❌ Ошибка сервера {res.status} при запросе {api_query}", 75)
                return []
            
            raw_data = res.json()
            if isinstance(raw_data, str):
                try: raw_data = json.loads(raw_data)
                except: pass
                
            items = raw_data.get("result", raw_data) if isinstance(raw_data, dict) else raw_data
            if not isinstance(items, list): return []
            
            matched = []
            for i in items:
                n = self.normalize_label_name(str(i.get("name", "")))
                t = self.normalize_label_name(str(i.get("tag_name", "")))
                k = self.normalize_label_name(str(i.get("key", "")))
                
                # Сравниваем с ИСХОДНЫМ именем, даже если скачали широкую базу
                if search_target == n or search_target == t or search_target == k:
                    matched.append(i)
            return matched

        try:
            # 1. Ищем по прямому имени (например, promo_currency_50)
            exact_matches = fetch_and_match(search_target)
            
            # 2. Если пусто — отрезаем цифры и качаем всю группу (promo_currency)
            if not exact_matches:
                param_match = re.search(r'([a-zA-Z_]+)_?\d+$', search_target)
                if param_match:
                    base_target = param_match.group(1).rstrip('_')
                    if log_cb: log_cb(f"   ⚠️ Имя '{search_target}' не найдено. Качаем базу: '{base_target}'...", 75)
                    exact_matches = fetch_and_match(base_target)

            # 3. Если всё равно пусто — ругаемся в терминал
            if not exact_matches:
                if log_cb: log_cb(f"   ❌ Лейбл '{label_name}' физически отсутствует в БД Smartico (или нет прав).", 75)
                return None
                
            exact_matches.sort(key=lambda x: (x.get("status_id") == 2, -x.get("id", 0)), reverse=True)
            target = exact_matches[0]

            tag_id = target.get("id")
            tag_type_name = target.get("tagTypeName", "Static text")
            
            var_params = {"filter": json.dumps({"tag_name": target.get("name", label_name), "__request_version": 0, "tag_id": tag_id}), "range": "[0,99]", "sort": '["priority","ASC"]', "lbl": self.brand_id}
            var_res = self.ctx.request.get(f"https://{self.boapi_host}/api/labels_tags_variation", params=var_params, headers=self.headers)
            var_data = var_res.json() if var_res.ok else []
            raw_variations = var_data.get("result", var_data) if isinstance(var_data, dict) else var_data
            
            actual_default = target.get("tag_value", "")
            filtered_vars = []
            
            for v in raw_variations:
                cond = str(v.get("conditions_readable", "")).strip().lower()
                if not cond or cond in ["not set", "all users"]: actual_default = v.get("tag_value", "")
                else: filtered_vars.append(v)
            
            if log_cb: log_cb(f"   ✅ Успех! Найдено вариаций: {len(filtered_vars)}", 75)
            
            return {
                "id": tag_id, "default": actual_default, 
                "variations": filtered_vars, "tag_type_name": tag_type_name
            }
        except Exception as e: 
            if log_cb: log_cb(f"   ❌ Критическая ошибка парсинга {label_name}: {e}", 75)
            return None

    def _check_sms_shortlinks(self, values, target_utm):
        import random
        import requests
        
        def esc(t): return str(t).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')
        
        # Регулярка для поиска ссылок: с http:// и без (например rngsp.cc/z4x)
        url_pattern = re.compile(r'(https?://[^\s"\'<>{}]+|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/[^\s"\'<>{}]+)')
        valid_urls = set()
        
        for v in values:
            for match in url_pattern.findall(str(v)):
                url = match.strip()
                # Очищаем от прилипшей пунктуации в конце
                while url and url[-1] in ['.', ',', '!', '?', ';']:
                    url = url[:-1]
                # Игнорируем фейки и макросы
                if len(url) < 8 or "{{" in url or "}}" in url or "label." in url: continue
                if not url.startswith('http'): url = 'https://' + url
                valid_urls.add(url)
                
        if not valid_urls:
            return "", False, False
            
        sampled_urls = random.sample(list(valid_urls), min(3, len(valid_urls)))
        overall_utm_found = False
        
        # ⚡ ФИКС СТИЛЕЙ: Так как блок теперь наверху, делаем отступ и рамку снизу!
        html = "<div style='margin-bottom:16px; padding-bottom:16px; border-bottom:1px dashed #cbd5e1;'>"
        html += f"<b style='color:#334155; font-size:13px;'>🚀 Проверка Short-линков (случайная выборка: {len(sampled_urls)} шт.):</b>"
        html += "<div style='display:flex; flex-direction:column; gap:8px; margin-top:8px;'>"
        
        for short_url in sampled_urls:
            try:
                # Идем по ссылке сквозь все редиректы
                resp = requests.get(short_url, allow_redirects=True, stream=True, timeout=10)
                final_url = resp.url
                is_working = resp.ok
                
                # Ищем UTM кампании в финальном URL
                has_utm = target_utm and target_utm.lower() in final_url.lower()
                if has_utm: overall_utm_found = True
                
                status_badge = "<span style='color:#15803d; background:#dcfce7; padding:2px 6px; border-radius:12px; font-size:11px; font-weight:bold;'>✅ 200 OK</span>" if is_working else f"<span style='color:#b91c1c; background:#fee2e2; padding:2px 6px; border-radius:12px; font-size:11px; font-weight:bold;'>❌ HTTP {resp.status_code}</span>"
                
                if target_utm:
                    utm_badge = f"<span style='color:#15803d; background:#dcfce7; padding:2px 6px; border-radius:12px; font-size:11px; font-weight:bold;'>✅ UTM '{esc(target_utm)}'</span>" if has_utm else f"<span style='color:#b91c1c; background:#fee2e2; padding:2px 6px; border-radius:12px; font-size:11px; font-weight:bold;'>❌ Нет UTM '{esc(target_utm)}'</span>"
                else:
                    utm_badge = ""
                
                html += f"<div style='background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:10px; font-size:12px; font-family:monospace;'>"
                html += f"<div style='margin-bottom:6px; display:flex; gap:8px; align-items:center;'><b>Link:</b> <a href='{esc(short_url)}' target='_blank' style='color:#2563eb; text-decoration:none;'>{esc(short_url)}</a> {status_badge} {utm_badge}</div>"
                html += f"<div style='color:#475569; word-break:break-all;'><b>Dest:</b> <span style='color:#0f172a;'>{esc(final_url)}</span></div>"
                html += "</div>"
                
            except Exception as e:
                html += f"<div style='background:#fef2f2; border:1px solid #fca5a5; border-radius:6px; padding:10px; font-size:12px; color:#991b1b;'>"
                html += f"<div style='margin-bottom:6px;'><b>Link:</b> <a href='{esc(short_url)}' target='_blank' style='color:#b91c1c;'>{esc(short_url)}</a> <span style='color:#b91c1c; background:#fee2e2; padding:2px 6px; border-radius:12px; font-size:11px; font-weight:bold;'>❌ Ошибка (Таймаут/Недоступна)</span></div>"
                html += f"<div style='color:#7f1d1d;'>{esc(str(e))}</div>"
                html += "</div>"
                
        html += "</div></div>"
        
        # Возвращаем 3 значения (html, есть ли вообще ссылки, найден ли UTM)
        return html, True, overall_utm_found

    def get_email_details(self, email_id):
        if not email_id: return {}
        try:
            res = self.ctx.request.get(f"https://{self.boapi_host}/api/templated_mail/{email_id}", params={"lbl": self.brand_id}, headers=self.headers)
            if res.ok: 
                data = res.json()[0] if isinstance(res.json(), list) and res.json() else res.json()
                var_params = {"filter": json.dumps({"status": [1, 3], "resource_id": int(email_id)}), "range": "[0,499]", "sort": '["variation_priority","DESC"]', "lbl": self.brand_id}
                var_res = self.ctx.request.get(f"https://{self.boapi_host}/api/templated_mail_variation", params=var_params, headers=self.headers)
                items = var_res.json().get("result", var_res.json()) if var_res.ok and isinstance(var_res.json(), dict) else (var_res.json() if var_res.ok else [])
                data["variations"] = items if isinstance(items, list) else []
                return data
        except: pass
        return {}

    def get_personalized_email_preview(self, html_body, user_id):
        if not html_body: return ""
        
        preview_url = f"https://{self.boapi_host}/api/private-api"
        
        # Используем user_id "как есть", так как он уже содержит нужный префикс (например, 866:...)
        formatted_user_id = str(user_id)
        
        print(f" [Rendering for: {formatted_user_id}]", end="")
        
        print(f" [Rendering for: {formatted_user_id}]", end="") # Отладка в консоль
        
        preview_payload = {
            "method": "mails_getPersonalizedPreview",
            "params": {
                "body": {"body": html_body},
                "user_ext_id": formatted_user_id,
                "content_type": 0
            }
        }
        
        headers = {
            "accept": "application/json",
            "authorization": self.headers.get("authorization", ""),
            "content-type": "application/json",
            "active_label_id": self.brand_id,
            "origin": f"https://{self.drive_host}",
            "referer": f"https://{self.drive_host}/",
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
        }
        
        try:
            res_preview = self.ctx.request.post(
                preview_url, 
                params={"method": "mails_getPersonalizedPreview", "lbl": self.brand_id},
                headers=headers, 
                data=preview_payload, 
                timeout=10000
            )
            
            if res_preview.ok:
                raw_json = res_preview.json()
                personalized_html = raw_json.get("body", "")
                
                if not personalized_html:
                    debug_info = json.dumps(raw_json, ensure_ascii=False)[:300]
                    print(f" [Пусто. Дамп: {debug_info}]", end="")
                    return ""
                
                match = re.search(r'(<!DOCTYPE|<html|<body|<table|<div|<center)', personalized_html, re.IGNORECASE)
                if match:
                    personalized_html = personalized_html[match.start():]
                
                personalized_html = re.sub(r"\(function\(\)\s*\{[^<]*?return\s*['\"]", "", personalized_html, flags=re.IGNORECASE)
                personalized_html = re.sub(r"['\"]\s*;\s*\}.*?\)\(\)\s*;?", "", personalized_html, flags=re.DOTALL)
                
                return personalized_html
            else:
                print(f" [HTTP {res_preview.status}]", end="")
        except Exception as e:
            print(f" [Ошибка: {type(e).__name__}]", end="")
            
        return ""

    def get_sms_details(self, sms_id):
        if not sms_id: return {}
        try:
            res = self.ctx.request.get(f"https://{self.boapi_host}/api/resource_sms/{sms_id}", params={"lbl": self.brand_id}, headers=self.headers)
            if res.ok: 
                data = res.json()[0] if isinstance(res.json(), list) and res.json() else res.json()
                var_params = {"filter": json.dumps({"status": [1, 3], "resource_id": int(sms_id)}), "range": "[0,499]", "sort": '["variation_priority","DESC"]', "lbl": self.brand_id}
                var_res = self.ctx.request.get(f"https://{self.boapi_host}/api/resource_sms_variation", params=var_params, headers=self.headers)
                items = var_res.json().get("result", var_res.json()) if var_res.ok and isinstance(var_res.json(), dict) else (var_res.json() if var_res.ok else [])
                data["variations"] = items if isinstance(items, list) else []
                return data
        except: pass
        return {}

    def get_push_details(self, push_id):
        if not push_id: return {}
        try:
            res = self.ctx.request.get(f"https://{self.boapi_host}/api/resource_push/{push_id}", params={"lbl": self.brand_id}, headers=self.headers)
            if res.ok: 
                data = res.json()[0] if isinstance(res.json(), list) and res.json() else res.json()
                var_params = {"filter": json.dumps({"status": [1, 3], "resource_id": int(push_id)}), "range": "[0,499]", "sort": '["variation_priority","DESC"]', "lbl": self.brand_id}
                var_res = self.ctx.request.get(f"https://{self.boapi_host}/api/resource_push_variation", params=var_params, headers=self.headers)
                items = var_res.json().get("result", var_res.json()) if var_res.ok and isinstance(var_res.json(), dict) else (var_res.json() if var_res.ok else [])
                data["variations"] = items if isinstance(items, list) else []
                return data
        except: pass
        return {}

    def get_inapp_details(self, inapp_id):
        if not inapp_id: return {}
        try:
            res = self.ctx.request.get(f"https://{self.boapi_host}/api/resource_inapp/{inapp_id}", params={"lbl": self.brand_id}, headers=self.headers)
            if res.ok: 
                data = res.json()[0] if isinstance(res.json(), list) and res.json() else res.json()
                var_params = {"filter": json.dumps({"status": [1, 3], "resource_id": int(inapp_id)}), "range": "[0,499]", "sort": '["variation_priority","DESC"]', "lbl": self.brand_id}
                var_res = self.ctx.request.get(f"https://{self.boapi_host}/api/resource_inapp_variation", params=var_params, headers=self.headers)
                # Фолбэк на случай если Smartico использует templated_popup_variation
                if not var_res.ok:
                    var_res = self.ctx.request.get(f"https://{self.boapi_host}/api/templated_popup_variation", params=var_params, headers=self.headers)
                items = var_res.json().get("result", var_res.json()) if var_res.ok and isinstance(var_res.json(), dict) else (var_res.json() if var_res.ok else [])
                data["variations"] = items if isinstance(items, list) else []
                return data
        except: pass
        return {}

    def resolve_conditions_async(self, cjm_query):
        proper_cjm_query = {
            "operator": "and",
            "conditions": cjm_query
        }
        payload = {
            "method": "getConditionsReadableAsync",
            "params": {"cjmQuery": proper_cjm_query, "fields": []}
        }
        try:
            res = self.ctx.request.post(f"https://{self.boapi_host}/api/private-api", 
                                        params={"method": "getConditionsReadableAsync", "lbl": self.brand_id},
                                        headers=self.headers, data=json.dumps(payload))
            if res.ok:
                data = res.json()
                
                # 🚨 ФИКС: Если Smartico вернул строку вместо JSON-объекта, парсим её принудительно
                if isinstance(data, str):
                    try: data = json.loads(data)
                    except: pass
                
                if isinstance(data, dict):
                    return data.get("result", "")
                return str(data)
            else:
                print(f"\n[DEBUG] Ошибка API Conditions: {res.status} - {res.text()}")
        except Exception as e:
            print(f"\n[DEBUG] Исключение в resolve_conditions_async: {e}")
        return None

    def get_tag_names_by_ids(self, tag_ids):
    
        if not tag_ids: return {}
        url = f"https://{self.boapi_host}/api/labels_tags"
        query_params = {"filter": json.dumps({"id": tag_ids}), "lbl": self.brand_id}
        res = self.ctx.request.get(url, params=query_params, headers=self.headers)
        if not res.ok: return {}
        data = res.json()
        items = data.get("result", data) if isinstance(data, dict) else data
        return {str(item["id"]): str(item.get("v") or item.get("name", item["id"])) for item in items if "id" in item}

    def build_flow_html(self, nodes_raw, transitions_raw):
        """Генерирует HTML-блок с деревом флоу. Включает тултипы, парсинг правил и СТАТИСТИКУ ПЕРЕХОДОВ."""
        if not nodes_raw or not transitions_raw:
            return ""
            
        import base64
        import json
        import re
        from collections import defaultdict
        
        nodes_by_id = {str(n["id"]): n for n in nodes_raw}
        target_nodes_by_aud_id = defaultdict(list) # 🚨 ФИКС: Храним ВСЕ ноды с одинаковым Aud_ID в списке
        
        for n in nodes_raw:
            aud_id = str(n.get("audience_id", ""))
            if not aud_id or aud_id == "None": aud_id = str(n.get("given_by_audience_id", ""))
            if not aud_id or aud_id == "None":
                details = n.get("details_json", "{}")
                if isinstance(details, str):
                    try: details = json.loads(details)
                    except: details = {}
                # 🚨 Защита от NoneType
                if not isinstance(details, dict): details = {}
                
                aud_id = str(details.get("given_by_audience_id", ""))
            if aud_id and aud_id != "None":
                target_nodes_by_aud_id[aud_id].append(n) # Добавляем в список, а не перезаписываем

        unique_links = set() 
        
        for aud in transitions_raw:
            source_id = str(aud.get("enabled_by_activity_id", ""))
            trans_aud_id = str(aud.get("id", ""))
            
            # 🚨 ФИКС: Игнорируем фантомные стрелки из пустоты. Никаких Entry Point!
            if not source_id or source_id == "None":
                continue 
            
            source_node = nodes_by_id.get(source_id)
            target_nodes = target_nodes_by_aud_id.get(trans_aud_id, [])
            
            if source_node and target_nodes:
                t_val = ""
                for c in aud.get("conditions") or []:
                    if c.get("p") == "event.action":
                        t_val = str(c.get("v", "")).strip("'\"")
                        break
                if not t_val: t_val = aud.get("event_type_name", "Next Step").replace("System: ", "").replace("Core: ", "")
                
                for target_node in target_nodes:
                    target_id = str(target_node["id"])
                    unique_links.add((source_id, t_val, target_id))

        # 🚨 ФИКС: Склеиваем системную стартовую ноду с первой реальной нодой флоу.
        # Smartico дает им одинаковый Aud_ID, так как обе триггерятся стартом.
        for aud_id, nodes_list in target_nodes_by_aud_id.items():
            if len(nodes_list) > 1:
                # Ищем ноду "Campaign Started" или аналогичную
                start_node = next((n for n in nodes_list if "start" in n.get("activity_name", "").lower() or "start" in n.get("name", "").lower()), None)
                if start_node:
                    start_id = str(start_node["id"])
                    for other_node in nodes_list:
                        other_id = str(other_node["id"])
                        if other_id != start_id:
                            # Принудительно пускаем стрелочку от Start к реальной ноде
                            unique_links.add((start_id, "Triggered", other_id))

        links = list(unique_links)

        graph = defaultdict(list)
        incoming = defaultdict(int)
        all_nodes = set()
        for src_id, cond, tgt_id in links:
            graph[src_id].append((cond, tgt_id))
            incoming[tgt_id] += 1
            all_nodes.add(src_id)
            all_nodes.add(tgt_id)

        roots = [n for n in all_nodes if incoming[n] == 0]
        if not roots and all_nodes: roots = [list(all_nodes)[0]]

        # 🚨 ФИКС: Оставляем только 1 самую главную стартовую точку
        if roots:
            roots.sort(key=lambda x: len(graph.get(x, [])), reverse=True)
            roots = [roots[0]]

        def esc(t): return str(t).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')

        def format_smartico_rule(rule_str):
            rule_str = rule_str.strip()
            if not rule_str: return ""
            m_op = re.match(r"^'([^']+)'\s+(.+?)\s+\((.*)\)$", rule_str)
            if m_op: return f"✔️ - {esc(m_op.group(1))} <span style='color:#cbd5e1; margin:0 4px;'>|</span> <span style='color:#3b82f6; font-weight:bold;'>{esc(m_op.group(2))}</span> <span style='color:#cbd5e1; margin:0 4px;'>|</span> <b>{esc(m_op.group(3))}</b>"
            m_op_num = re.match(r"^'([^']+)'\s+(.+?)\s+(\d+)$", rule_str)
            if m_op_num: return f"✔️ - {esc(m_op_num.group(1))} <span style='color:#cbd5e1; margin:0 4px;'>|</span> <span style='color:#3b82f6; font-weight:bold;'>{esc(m_op_num.group(2))}</span> <span style='color:#cbd5e1; margin:0 4px;'>|</span> <b>{esc(m_op_num.group(3))}</b>"
            m_not = re.match(r"^not\s+'([^']+)'$", rule_str, re.IGNORECASE)
            if m_not: return f"✔️ - {esc(m_not.group(1))} <span style='color:#cbd5e1; margin:0 4px;'>|</span> <span style='color:#3b82f6; font-weight:bold;'>=</span> <span style='color:#cbd5e1; margin:0 4px;'>|</span> <b>False</b>"
            m_true = re.match(r"^'([^']+)'$", rule_str)
            if m_true: return f"✔️ - {esc(m_true.group(1))} <span style='color:#cbd5e1; margin:0 4px;'>|</span> <span style='color:#3b82f6; font-weight:bold;'>=</span> <span style='color:#cbd5e1; margin:0 4px;'>|</span> <b>True</b>"
            return f"✔️ - {esc(rule_str)}"

        def normalize_rule_string(rule_str):
            m = re.search(r'\(([^()]+)\)\s*$', rule_str)
            if m:
                inner = m.group(1)
                if not inner.strip(): return rule_str
                vals = []
                for v in inner.split(','):
                    v = v.strip()
                    if ' / ' in v: v = v.split(' / ')[-1].strip()
                    vals.append(v)
                vals.sort(key=lambda x: x.lower())
                return rule_str[:m.start(1)] + "(" + ", ".join(vals) + ")" + rule_str[m.end(1):]
            return rule_str

        def parse_and_build_html(c_raw):
            if not c_raw or c_raw == "No conditions" or c_raw.strip() == "()":
                return ""
            rules = [r.strip() for r in re.split(r'\nAND\s+|\s+AND\s+', c_raw) if r.strip()]
            or_rules = []
            std_rules = []
            for r in rules:
                r_clean = re.sub(r'\s*\n\s*', ' ', r).strip()
                if re.search(r'\bOR\b', r_clean) and r_clean.lstrip(" '\"").startswith("("):
                    or_rules.append(r_clean.strip("'\""))
                else:
                    std_rules.append(normalize_rule_string(r_clean))
            html_parts = []
            if or_rules:
                or_inner = "<br>".join([f"🔸 <span style='color:#b45309; font-family:monospace;'>{esc(r)}</span>" for r in or_rules])
                html_parts.append(f"<div style='background:#fef3c7; border:1px solid #fde68a; border-left:4px solid #f59e0b; padding:8px 12px; border-radius:4px; margin-bottom:10px; font-size:13px;'><b>⚠️ Сработает любое из условий (OR):</b><br>{or_inner}</div>")
            if std_rules:
                html_parts.append("<br>".join([format_smartico_rule(r) for r in std_rules]))
            return "".join(html_parts)

        # 🚨 Мы убрали аргументы drive_host, brand_id и api, так как они есть в self
        def get_node_box_html(node_obj, n_low):
            if not node_obj: return "Unknown"
            node_name = node_obj.get("activity_name") or node_obj.get("name") or f"Node {node_obj.get('id')}"
            
            if node_name == "Start campaign":
                node_name = "Another Campaign"
                n_low = "another campaign"
                
            details = node_obj.get("details_json", {})
            if isinstance(details, str):
                try: details = json.loads(details)
                except: details = {}
            
            # 🚨 Защита от NoneType
            if not isinstance(details, dict): details = {}

            modal_html_blocks = []
            
            branches_data = details.get("branches")
            if not branches_data and isinstance(details.get("details"), dict):
                branches_data = details.get("details").get("branches")
                
            user_checks_data = details.get("user_checks")
            
            if branches_data and isinstance(branches_data, list):
                for b in branches_data:
                    b_name = b.get("name", "Unknown branch")
                    c_raw = str(b.get("condition", "")).strip()
                    
                    # 🚨 Обращаемся к функции починки скобок через self
                    if "()" in c_raw: c_raw = self.fix_empty_brackets_locally(c_raw, b.get("conditions") or [])
                        
                    if c_raw and c_raw not in ["No conditions", "()"]:
                        parsed = parse_and_build_html(c_raw)
                        modal_html_blocks.append(f"<div style='margin-bottom: 10px;'><b style='color: #0f172a; font-size: 14px;'>🔀 {esc(b_name)}</b><div style='margin-top: 6px; background: #f8fafc; border: 1px solid #e2e8f0; border-left: 4px solid #3b82f6; padding: 8px; border-radius: 4px; font-family: monospace; font-size: 12px; color: #334155; word-wrap: break-word;'>{parsed}</div></div>")
                    else:
                        modal_html_blocks.append(f"<div style='margin-bottom: 10px;'><b style='color: #0f172a; font-size: 14px;'>🔀 {esc(b_name)}</b><div style='margin-top: 6px; color: #94a3b8; font-size: 12px; font-style: italic;'>Нет заданных условий (All users)</div></div>")
                    
            elif user_checks_data and isinstance(user_checks_data, list):
                for b in user_checks_data:
                    b_name = b.get("name", "Unknown branch")
                    c_dict = b.get("conditions_n_readable", {})
                    c_raw = c_dict.get("conditions_readable", "")
                    
                    # 🚨 Обращаемся к функции починки скобок через self
                    if "()" in c_raw: c_raw = self.fix_empty_brackets_locally(c_raw, c_dict.get("conditions", []))
                        
                    if c_raw and c_raw not in ["No conditions", "()", "Not set"]:
                        parsed = parse_and_build_html(c_raw)
                        modal_html_blocks.append(f"<div style='margin-bottom: 10px;'><b style='color: #0f172a; font-size: 14px;'>🎯 {esc(b_name)}</b><div style='margin-top: 6px; background: #f8fafc; border: 1px solid #e2e8f0; border-left: 4px solid #10b981; padding: 8px; border-radius: 4px; font-family: monospace; font-size: 12px; color: #334155; word-wrap: break-word;'>{parsed}</div></div>")
                    else:
                        modal_html_blocks.append(f"<div style='margin-bottom: 10px;'><b style='color: #0f172a; font-size: 14px;'>🎯 {esc(b_name)}</b><div style='margin-top: 6px; color: #94a3b8; font-size: 12px; font-style: italic;'>Нет заданных условий (All users)</div></div>")
                    
            else:
                rule_dict = details.get("rule", {})
                c_dict = details.get("conditions_n_readable", {})
                c_raw = details.get("condition") or rule_dict.get("conditions_readable") or c_dict.get("readable") or details.get("segment_conditions_readable") or details.get("conditions_readable")
                
                if isinstance(c_raw, dict): c_raw = c_raw.get("readable", "")
                if not c_raw or c_raw == "Not set": c_raw = c_dict.get("readable") or ""
                c_raw = str(c_raw).strip()
                
                # 🚨 Обращаемся к функции починки скобок через self
                if "()" in c_raw:
                    raw_conds = rule_dict.get("conditions") or c_dict.get("conditions") or []
                    c_raw = self.fix_empty_brackets_locally(c_raw, raw_conds)
                
                if c_raw and c_raw not in ["Not set", "()", "No conditions", "All users"]:
                    parsed = parse_and_build_html(c_raw)
                    if parsed:
                        modal_html_blocks.append(f"<div style='margin-bottom: 10px;'><b style='color: #334155; font-size: 14px;'>🕵️‍♂️ Условия ноды</b><div style='margin-top: 6px; background: #ffffff; border: 1px solid #e2e8f0; border-left: 4px solid #94a3b8; padding: 8px; border-radius: 4px; font-family: monospace; font-size: 12px; color: #334155; word-wrap: break-word;'>{parsed}</div></div>")

            if "delay" in details:
                try:
                    ms = int(details["delay"])
                    if ms >= 86400000 and ms % 86400000 == 0: d_str = f"{ms // 86400000} days"
                    elif ms >= 3600000 and ms % 3600000 == 0: d_str = f"{ms // 3600000} hours"
                    elif ms >= 60000 and ms % 60000 == 0: d_str = f"{ms // 60000} minutes"
                    elif ms >= 1000: d_str = f"{ms // 1000} seconds"
                    else: d_str = f"{ms} ms"
                    modal_html_blocks.append(f"<div style='margin-bottom: 10px;'><b style='color: #334155; font-size: 14px;'>⏳ Delay:</b><div style='margin-top: 6px; background: #ffffff; border: 1px solid #e2e8f0; border-left: 4px solid #a855f7; padding: 8px; border-radius: 4px; font-size: 12px; color: #334155;'>Delay for {d_str}</div></div>")
                except: pass

            if "core_tags" in details or "tags" in details:
                tags_raw = details.get("core_tags") or details.get("tags", "")
                tags_str = str(tags_raw).strip("[]").replace('"', '')
                if tags_str:
                    modal_html_blocks.append(f"<div style='margin-bottom: 10px;'><b style='color: #334155; font-size: 14px;'>🏷️ Mark User:</b><div style='margin-top: 6px; background: #ffffff; border: 1px solid #e2e8f0; border-left: 4px solid #14b8a6; padding: 8px; border-radius: 4px; font-family: monospace; font-size: 12px; color: #334155;'>Tags: {esc(tags_str)}</div></div>")

            if "audience_id" in details and "another campaign" in n_low:
                t_aud_id = details["audience_id"]
                c_name = details.get("_campaign_name", f"Campaign {t_aud_id}")
                # 🚨 Берем хост и бренд из self
                camp_link = f"https://{self.drive_host}/{self.brand_id}#/j_audience_scheduled/{t_aud_id}" if self.brand_id else "#"
                modal_html_blocks.append(f"<div style='margin-bottom: 10px;'><b style='color: #334155; font-size: 14px;'>🚀 Another Campaign:</b><div style='margin-top: 6px; background: #ffffff; border: 1px solid #e2e8f0; border-left: 4px solid #3b82f6; padding: 8px; border-radius: 4px; font-size: 12px;'><a href='{camp_link}' target='_blank' style='color:#2563eb; text-decoration:underline;'>{esc(c_name)}</a> <span style='color:#94a3b8;'>(ID: {t_aud_id})</span></div></div>")

            if "wait" in n_low:
                if "event_type_uiname" in details or "event_type_name" in details:
                    node_name = details.get("event_type_uiname") or details.get("event_type_name")
                if "timeout" in details:
                    try:
                        ms = int(details["timeout"])
                        if ms >= 86400000 and ms % 86400000 == 0: t_str = f"{ms // 86400000} days"
                        elif ms >= 3600000 and ms % 3600000 == 0: t_str = f"{ms // 3600000} hours"
                        elif ms >= 60000 and ms % 60000 == 0: t_str = f"{ms // 60000} minutes"
                        elif ms >= 1000: t_str = f"{ms // 1000} seconds"
                        else: t_str = f"{ms} ms"
                        modal_html_blocks.append(f"<div style='margin-bottom: 10px;'><b style='color: #334155; font-size: 14px;'>⏳ Wait Timeout:</b><div style='margin-top: 6px; background: #ffffff; border: 1px solid #e2e8f0; border-left: 4px solid #7e22ce; padding: 8px; border-radius: 4px; font-size: 12px; color: #334155;'>{t_str}</div></div>")
                    except: pass

            is_pop, is_comm = False, False
            if "popup" in n_low or "in-app" in n_low or "inapp" in n_low:
                is_comm, is_pop = True, True
            elif "email" in n_low or "push" in n_low or "sms" in n_low:
                is_comm = True

            if is_comm:
                d = details.get("details", details) if isinstance(details.get("details"), dict) else details
                caps_map = {1: "Respect user level and global caps", 2: "Ignore user and global level caps", 3: "Respect user caps, but ignore global caps", 4: "Respect global caps, but ignore user caps"}
                caps = caps_map.get(d.get("caps_impact"), "N/A")
                if caps == "N/A": 
                    ignore_caps = d.get("ignore_frequency_capping") if d.get("ignore_frequency_capping") is not None else d.get("ignore_caps", False)
                    caps = "Ignore caps" if ignore_caps else "Respect user and global caps"
                
                opt = "N/A"
                if not is_pop:
                    optout_map = {1: "Respect Platform and Smartico opt-out flags", 2: "Ignore Platform, opt-out flags, but respect Smartico", 3: "Ignore Smartico opt-out flags, but respect Platform", 4: "Ignore platform and Smartico opt-out flags"}
                    opt = optout_map.get(d.get("optout_impact"), "N/A")
                    if opt == "N/A":
                        ignore_opt = d.get("ignore_opt_out") if d.get("ignore_opt_out") is not None else d.get("ignore_optout", False)
                        opt = "Ignore Opt-out" if ignore_opt else "Respect Platform and Smartico"
                    
                dt = "N/A"
                if is_pop:
                    timeout_ms = d.get("delivery_timeout_ms", 0)
                    if timeout_ms > 0:
                        t_mins = timeout_ms // 60000
                        if t_mins >= 1440 and t_mins % 1440 == 0: dt = f"{t_mins // 1440} days"
                        elif t_mins >= 60 and t_mins % 60 == 0: dt = f"{t_mins // 60} hours"
                        elif t_mins >= 60: dt = f"{t_mins // 60}h {t_mins % 60}m"
                        else: dt = f"{t_mins} minutes"
                    else:
                        dt_val = d.get("delivery_timeout") or d.get("expiration_time")
                        if dt_val is not None and str(dt_val).strip() != "":
                            try:
                                val = int(dt_val)
                                if val >= 3600000 and val % 3600000 == 0: dt = f"{val // 3600000} hours"
                                elif val >= 60000 and val % 60000 == 0: dt = f"{val // 60000} minutes"
                                elif val >= 1000 and val % 1000 == 0: dt = f"{val // 1000} seconds"
                                else: dt = f"{val} ms"
                            except: dt = str(dt_val)
                
                period_disp = "N/A"
                if not is_pop:
                    period_map = {1: "Send only in activity period", 2: "Send always, disregarding activity period", 3: "Send if possible and if not - in next available activity period", 4: "Send in specific hour (User TZ)", 5: "Send in specific hour (UTC)", 260: "BEST TIME: Deposit+SB+CASINO Bet", 261: "BEST TIME: Online", 262: "BEST TIME: Clicks"}
                    period = d.get("period")
                    if period is not None:
                        period_str = period_map.get(period, f"ID: {period}")
                        time_str = ""
                        if period == 1:
                            a_from = str(d.get("activity_from_time", "00:00"))
                            a_to = str(d.get("activity_to_time", "23:59"))
                            tz = "in user timezone" if d.get("use_user_tz", True) else "in UTC"
                            time_str = f"From {a_from} till {a_to} {tz}"
                        elif period in [4, 5]:
                            time_str = f"From {d.get('time_to_send', 'N/A')}"
                        period_disp = f"{period_str}. {time_str}".strip() if time_str else period_str
                    else: 
                        time_config = d.get("time_filter") or d.get("schedule_config") or d.get("execution_hours") or d.get("timeFilter") or d
                        if not isinstance(time_config, dict): time_config = {}
                        from_time = time_config.get("from") or time_config.get("time_from") or time_config.get("send_time_from") or ""
                        to_time = time_config.get("to") or time_config.get("time_to") or time_config.get("send_time_to") or ""
                        if from_time or to_time:
                            tz_raw = str(time_config.get("tz") or time_config.get("timezone_type") or d.get("timezone_type") or "")
                            tz = "User TZ" if tz_raw in ["1", "user", "User"] else "Campaign TZ"
                            if from_time and to_time: period_disp = f"Send in specific hour ({tz}). From {from_time} to {to_time}"
                            elif from_time: period_disp = f"Send in specific hour ({tz}). From {from_time}"
                            elif to_time: period_disp = f"Send in specific hour ({tz}). To {to_time}"

                li_parts = []
                
                # --- ЛОГИКА ДОБАВЛЕНИЯ ССЫЛКИ ---
                res_id = d.get("resource_id") or d.get("id")
                if not res_id and "resources" in d and isinstance(d["resources"], list) and d["resources"]:
                    res_id = d["resources"][0].get("resource_id") or d["resources"][0].get("id")
                
                if res_id:
                    t_type = node_obj.get("activity_type_id")
                    link_url = ""
                    if t_type == 50 or "email" in n_low: link_url = f"https://{self.drive_host}/{self.brand_id}#/templated_mail/{res_id}"
                    elif t_type == 40 or "push" in n_low: link_url = f"https://{self.drive_host}/{self.brand_id}#/resource_push/{res_id}"
                    elif t_type == 60 or "sms" in n_low: link_url = f"https://{self.drive_host}/{self.brand_id}#/resource_sms/{res_id}"
                    elif t_type == 30 or is_pop: link_url = f"https://{self.drive_host}/{self.brand_id}#/templated_popup/{res_id}"
                    
                    if link_url:
                        li_parts.append(f"<div style='margin-bottom:6px; padding-bottom:6px; border-bottom:1px dashed #cbd5e1;'><b>🔗 <a href='{link_url}' target='_blank' style='color:#2563eb; text-decoration:none;'>Открыть коммуникацию ↗</a></b></div>")
                # --------------------------------
                
                if period_disp != "N/A": li_parts.append(f"<div style='margin-bottom:4px;'><b>⏱️ Allowed Hours:</b> <span style='color: #444;'>{period_disp}</span></div>")
                if dt != "N/A": li_parts.append(f"<div style='margin-bottom:4px;'><b>⏱️ Delivery timeout:</b> <span style='color: #444;'>{dt}</span></div>")
                if opt != "N/A": li_parts.append(f"<div style='margin-bottom:4px;'><b>🚫 Opt-out Status:</b> <span style='color: #444;'>{opt}</span></div>")
                if caps != "N/A": li_parts.append(f"<div><b>🛑 Caps Status:</b> <span style='color: #444;'>{caps}</span></div>")
                    
                if li_parts:
                    settings_html = "".join(li_parts)
                    modal_html_blocks.append(f"<div style='margin-bottom: 10px;'><b style='color: #334155; font-size: 14px;'>⚙️ Node Settings</b><div style='margin-top: 6px; background: #f8fafc; border: 1px solid #e2e8f0; border-left: 4px solid #64748b; padding: 8px; border-radius: 4px; font-size: 12px; color: #334155;'>{settings_html}</div></div>")

            if "saw_template_id" in details and "mini game" in n_low:
                t_id = details["saw_template_id"]
                c_name = details.get("_saw_template_name", f"Game {t_id}")
                attempts = details.get("saw_attempts_count", 1)
                t_out = details.get("delivery_timeout_ms")
                t_out_str = "Unlimited / Not set"
                if t_out is not None and str(t_out).strip() != "":
                    try:
                        val = int(t_out)
                        if val >= 86400000 and val % 86400000 == 0: t_out_str = f"{val // 86400000} days"
                        elif val >= 3600000 and val % 3600000 == 0: t_out_str = f"{val // 3600000} hours"
                        elif val >= 60000 and val % 60000 == 0: t_out_str = f"{val // 60000} minutes"
                        elif val >= 1000 and val % 1000 == 0: t_out_str = f"{val // 1000} seconds"
                        else: t_out_str = f"{val} ms"
                    except: t_out_str = str(t_out)

                # 🚨 Берем хост и бренд из self
                game_link = f"https://{self.drive_host}/{self.brand_id}#/saw_template/{t_id}" if self.brand_id else "#"
                modal_html_blocks.append(f"<div style='margin-bottom: 10px;'><b style='color: #334155; font-size: 14px;'>🎮 Mini Game:</b><div style='margin-top: 6px; background: #ffffff; border: 1px solid #e2e8f0; border-left: 4px solid #a855f7; padding: 8px; border-radius: 4px; font-size: 12px; color: #334155;'><a href='{game_link}' target='_blank' style='color:#9333ea; text-decoration:underline;'>{esc(c_name)}</a> <span style='color:#94a3b8;'>(ID: {t_id})</span><br><br><b>Attempts:</b> {attempts}<br><b>Timeout:</b> {t_out_str}</div></div>")

            if "achievement_id" in details and "give mission" in n_low:
                m_id = details["achievement_id"]
                m_name = details.get("_achievement_name", f"Mission {m_id}")
                reset_mode = details.get("mission_reset_mode", 0)
                reset_map = {0: "Keep progress if the mission was already given to a user", 1: "Reset progress, if the mission was given, but not COMPLETED yet", 2: "Reset progress and restart mission, if it was given and already COMPLETED", 3: "Reset progress if the mission was already given to a user"}
                reset_str = reset_map.get(reset_mode, f"Unknown mode ({reset_mode})")
                
                # 🚨 Берем хост и бренд из self
                mission_link = f"https://{self.drive_host}/{self.brand_id}#/ach_achievement/{m_id}" if self.brand_id else "#"
                modal_html_blocks.append(f"<div style='margin-bottom: 10px;'><b style='color: #334155; font-size: 14px;'>🎖️ Mission:</b><div style='margin-top: 6px; background: #ffffff; border: 1px solid #e2e8f0; border-left: 4px solid #f59e0b; padding: 8px; border-radius: 4px; font-size: 12px; color: #334155;'><a href='{mission_link}' target='_blank' style='color:#d97706; text-decoration:underline;'>{esc(m_name)}</a> <span style='color:#94a3b8;'>(ID: {m_id})</span><br><br><b>Reset:</b> {reset_str}</div></div>")

            cls = "padding: 10px 16px; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 13px; font-weight: bold; background: #fff; box-shadow: 0 2px 4px rgba(0,0,0,0.05); white-space: nowrap; position: relative; z-index: 2; text-align: center; display: flex; flex-direction: column; align-items: center;"
            icon = "🔵"
            if "convert" in n_low: cls += " background: #dcfce7; border-color: #86efac; color: #15803d;"; icon = "🏆"
            elif "stop" in n_low: cls += " background: #fee2e2; border-color: #fca5a5; color: #b91c1c;"; icon = "🛑"
            elif "wait" in n_low or "delay" in n_low: cls += " background: #f3e8ff; border-color: #e9d5ff; color: #7e22ce;"; icon = "⏳"
            elif "check" in n_low or "split" in n_low or "profile" in n_low: cls += " background: #e0f2fe; border-color: #7dd3fc; color: #0369a1;"; icon = "🔀"
            elif "mark user" in n_low: cls += " background: #ccfbf1; border-color: #5eead4; color: #0f766e;"; icon = "🏷️"
            elif "another campaign" in n_low or "start campaign" in n_low: cls += " background: #dbeafe; border-color: #bfdbfe; color: #1e40af;"; icon = "🚀"
            elif "mini game" in n_low: cls += " background: #faf5ff; border-color: #d8b4fe; color: #7e22ce;"; icon = "🎮"
            elif "give mission" in n_low: cls += " background: #fffbeb; border-color: #fcd34d; color: #b45309;"; icon = "🎖️"
            else: cls += " color: #0f172a;"
            
            class_str = ""
            data_info = ""
            tooltip_dom = ""
            
            if modal_html_blocks:
                cls += " cursor: pointer; border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);"
                class_str = "flow-node-clickable"
                payload = {"title": node_name, "html": "".join(modal_html_blocks)}
                b64_str = base64.b64encode(json.dumps(payload).encode('utf-8')).decode('utf-8')
                data_info = f" data-info='{b64_str}'"
                tooltip_dom = f"<div class='flow-tooltip'>{''.join(modal_html_blocks)}</div>"
                
            return f"<div class='{class_str}'{data_info} style='{cls}'><div style='display:flex; align-items:center; gap:6px;'>{icon} {esc(node_name)}</div>{tooltip_dom}</div>"

        def generate_tree_html(node_id, visited):
            node_obj = nodes_by_id.get(node_id, {})
            node_name = node_obj.get("activity_name") or node_obj.get("name") or f"Node {node_id}"
            
            # 🚨 Вызываем без лишних аргументов
            html = get_node_box_html(node_obj, node_name.lower())
            
            children = graph.get(node_id, [])
            if not children: return html
            
            p_count_raw = node_obj.get("report_activities_count")
            p_count = int(p_count_raw) if p_count_raw is not None else 0
            
            child_html = "<div style='display: flex; flex-direction: column; gap: 12px; border-left: 2px solid #cbd5e1; padding-top: 10px; padding-bottom: 10px;'>"
            for cond, child_id in children:
                cond_print = esc(cond.replace("(MATCHING) ", ""))
                
                child_obj = nodes_by_id.get(child_id, {})
                c_count_raw = child_obj.get("report_activities_count")
                c_count = int(c_count_raw) if c_count_raw is not None else 0
                
                stats_html = f"<div class='flow-stats' style='font-size: 10px; color: #64748b; margin-top: 2px; font-weight: normal;'>{c_count} / {p_count}</div>"
                
                child_html += f"<div style='display: flex; align-items: center;'>"
                child_html += f"<div style='width: 25px; height: 2px; background: #cbd5e1;'></div>"
                child_html += f"<div style='color: #475569; font-size: 11px; background: #f8fafc; padding: 4px 10px; border-radius: 12px; border: 1px solid #cbd5e1; white-space: nowrap; user-select: none; text-align: center; line-height: 1.2;'>{cond_print}{stats_html}</div>"
                child_html += f"<div style='width: 25px; height: 2px; background: #cbd5e1;'></div>"
                
                if child_id in visited:
                    child_low = (child_obj.get('name') or '').lower()
                    
                    # 🚨 Вызываем без лишних аргументов
                    child_html += f"<div style='opacity: 0.6;'>{get_node_box_html(child_obj, child_low)}</div>"
                else:
                    visited.add(child_id)
                    child_html += generate_tree_html(child_id, visited)
                child_html += "</div>"
            child_html += "</div>"
            return f"<div style='display: flex; align-items: center;'>{html}<div style='width: 25px; height: 2px; background: #cbd5e1;'></div>{child_html}</div>"

        flow_trees = ""
        global_visited = set()
        for r in roots:
            global_visited.add(r)
            flow_trees += f"""
            <div class="flow-map-container flow-map-hide-stats" style="position: relative; border: 1px solid #cbd5e1; border-radius: 8px; background: #f8fafc; margin-bottom: 20px; overflow: hidden;">
                <div style="padding: 10px 15px; border-bottom: 1px solid #cbd5e1; background: #ffffff; display: flex; justify-content: space-between; align-items: center;">
                    <b style="color: #334155; font-size: 13px;">🔎 Масштаб карты:</b>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; color: #475569; margin-right: 8px; padding-right: 12px; border-right: 1px solid #cbd5e1; user-select: none;">
                            <input type="checkbox" onchange="toggleFlowMode(this)" style="cursor:pointer; width:14px; height:14px; margin:0;"> 
                            <b style="color:#0f172a;">Раскрыть ноды</b>
                        </label>
                        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; color: #475569; margin-right: 8px; padding-right: 12px; border-right: 1px solid #cbd5e1; user-select: none;">
                            <input type="checkbox" onchange="toggleStatsMode(this)" style="cursor:pointer; width:14px; height:14px; margin:0;"> 
                            <b style="color:#0f172a;">Статистика</b>
                        </label>
                        <button type="button" onclick="setMapZoom(this, 0.5)" style="padding: 4px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 4px; cursor: pointer; background: #fff; color: #334155;">50%</button>
                        <button type="button" onclick="setMapZoom(this, 0.75)" style="padding: 4px 10px; font-size: 12px; border: 1px solid #bae6fd; border-radius: 4px; cursor: pointer; background: #e0f2fe; color: #0369a1; font-weight: bold;">75%</button>
                        <button type="button" onclick="setMapZoom(this, 1)" style="padding: 4px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 4px; cursor: pointer; background: #fff; color: #334155;">100%</button>
                        <button type="button" onclick="setMapZoom(this, 1.25)" style="padding: 4px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 4px; cursor: pointer; background: #fff; color: #334155;">125%</button>
                    </div>
                </div>
                <div class='drag-scroll' style='overflow: auto; max-height: 800px; cursor: grab; user-select: none; position: relative;'>
                    <div class="zoom-wrapper" style="zoom: 0.75; width: max-content; padding: 350px 300px 300px 300px; min-width: 100%;">
                        {generate_tree_html(r, global_visited)}
                    </div>
                </div>
            </div>
            """
            
        if flow_trees:
            return f"""
            <style>
            .flow-node-clickable .flow-tooltip {{ visibility: hidden; opacity: 0; position: absolute; bottom: 140%; left: 50%; transform: translateX(-50%); width: max-content; max-width: 450px; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 12px; padding: 15px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1); z-index: 10000; transition: opacity 0.2s ease, visibility 0.2s ease; white-space: normal; text-align: left; pointer-events: none; }}
            .flow-node-clickable:hover .flow-tooltip {{ visibility: visible; opacity: 1; }}
            .flow-node-clickable .flow-tooltip::after {{ content: ''; position: absolute; top: 100%; left: 50%; margin-left: -8px; border-width: 8px; border-style: solid; border-color: #ffffff transparent transparent transparent; z-index: 10001; }}
            .flow-node-clickable .flow-tooltip::before {{ content: ''; position: absolute; top: 100%; left: 50%; margin-left: -9px; border-width: 9px; border-style: solid; border-color: #cbd5e1 transparent transparent transparent; z-index: 10000; }}
            
            /* ✅ ФИНАЛЬНЫЙ ФИКС РАСКРЫТОГО РЕЖИМА */
            .flow-map-expanded .flow-node-clickable {{ 
                width: 350px !important; /* Увеличили ширину для читаемости */
                height: auto !important; 
                display: flex !important;
                flex-direction: column !important;
                align-items: flex-start !important; /* ВЫРАВНИВАНИЕ ВСЕГО ПО ЛЕВОМУ КРАЮ */
                padding: 15px !important;
                white-space: normal !important;
                box-sizing: border-box !important;
            }}

            .flow-map-expanded .flow-tooltip {{ 
                visibility: visible !important; 
                opacity: 1 !important; 
                position: relative !important; 
                transform: none !important; 
                background: none !important; 
                border: none !important;
                box-shadow: none !important; 
                margin: 12px 0 0 0 !important; /* Отступ от заголовка ноды */
                padding: 0 !important;
                pointer-events: auto !important; 
                width: 100% !important; /* Растягиваем на всю ширину ноды */
                display: flex !important;
                flex-direction: column !important;
                gap: 10px !important;
                left: 0 !important;
            }}
            
            /* Убираем стрелочки тултипа в раскрытом виде */
            .flow-map-expanded .flow-tooltip::after, 
            .flow-map-expanded .flow-tooltip::before {{ display: none !important; }}

            /* Корректируем внутренние плашки настроек, чтобы они не имели лишних отступов */
            .flow-map-expanded .flow-tooltip > div {{
                width: 100% !important;
                margin: 0 !important;
                box-sizing: border-box !important;
            }}
            
            /* Скрытие статистики по чекбоксу */
            .flow-map-hide-stats .flow-stats {{
                display: none !important;
            }}
            </style>
            
            <div style="margin: 10px 20px 20px 20px; font-family: sans-serif;">
                <details style="background: #f8fafc; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0; box-shadow: inset 0 1px 3px rgba(0,0,0,0.02);" open>
                    <summary style="cursor:pointer; font-weight:bold; color:#334155; font-size:15px; outline:none; user-select:none;">
                        🗺️ Интерактивная карта (Flow Builder Map) <span style="font-size:13px; font-weight:normal; color:#64748b; margin-left:15px;">Нажмите, чтобы свернуть/развернуть</span>
                    </summary>
                    <div style="margin-top: 20px;">
                        {flow_trees}
                    </div>
                </details>
            </div>
            
            <div id="flow-modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(15, 23, 42, 0.6); z-index:999999; align-items:center; justify-content:center; backdrop-filter: blur(2px);">
                <div style="background:#fff; padding:25px; border-radius:12px; width:750px; max-width:95%; max-height:85vh; overflow-y:auto; position:relative; box-shadow:0 10px 25px rgba(0,0,0,0.2); font-family: sans-serif;">
                    <button onclick="document.getElementById('flow-modal').style.display='none'" style="position:absolute; top:15px; right:15px; cursor:pointer; border:none; background:none; font-size:22px; color:#64748b;">&times;</button>
                    <h3 id="flow-modal-title" style="margin-top:0; color:#0f172a; border-bottom:2px solid #e2e8f0; padding-bottom:10px;">Node</h3>
                    <div id="flow-modal-body" style="margin-top: 15px;"></div>
                </div>
            </div>
            
            <script>
            if (!window.flowScriptInjected) {{
                window.flowScriptInjected = true;
                
                // 🚨 ФИКС: Логика переключения режима "Раскрыть ноды"
                window.toggleFlowMode = function(cb) {{
                    const container = cb.closest('.flow-map-container');
                    if(cb.checked) {{
                        container.classList.add('flow-map-expanded');
                    }} else {{
                        container.classList.remove('flow-map-expanded');
                    }}
                }};
                
                // Логика переключения статистики
                window.toggleStatsMode = function(cb) {{
                    const container = cb.closest('.flow-map-container');
                    if(cb.checked) {{
                        container.classList.remove('flow-map-hide-stats');
                    }} else {{
                        container.classList.add('flow-map-hide-stats');
                    }}
                }};
                
                window.setMapZoom = function(btn, scale) {{
                    const container = btn.closest('.flow-map-container');
                    const wrapper = container.querySelector('.zoom-wrapper');
                    wrapper.style.zoom = scale;
                    
                    const buttons = container.querySelectorAll('button');
                    buttons.forEach(b => {{
                        if(b.innerText.includes('%')) {{
                            b.style.background = '#fff';
                            b.style.color = '#334155';
                            b.style.borderColor = '#cbd5e1';
                            b.style.fontWeight = 'normal';
                        }}
                    }});
                    btn.style.background = '#e0f2fe';
                    btn.style.color = '#0369a1';
                    btn.style.borderColor = '#bae6fd';
                    btn.style.fontWeight = 'bold';
                }};

                (function() {{
                    const sliders = document.querySelectorAll('.drag-scroll');
                    let isDown = false, isDragging = false, startX, startY, scrollLeft, scrollTop;

                    sliders.forEach(slider => {{
                        setTimeout(() => {{
                            slider.scrollTop = 220; 
                            slider.scrollLeft = (slider.scrollWidth - slider.clientWidth) / 2; 
                        }}, 150);

                        slider.addEventListener('mousedown', (e) => {{
                            // Не блокируем случайные клики по чекбоксам и кнопкам
                            if (e.target.closest('input, button')) return; 
                            e.preventDefault(); // 🚨 ГЛАВНЫЙ ФИКС: отключает нативное перетаскивание
                            isDown = true; isDragging = false;
                            slider.style.cursor = 'grabbing';
                            startX = e.pageX - slider.offsetLeft; startY = e.pageY - slider.offsetTop;
                            scrollLeft = slider.scrollLeft; scrollTop = slider.scrollTop;
                        }});
                        slider.addEventListener('mousemove', (e) => {{
                            if(!isDown) return;
                            e.preventDefault(); // 🚨 Предотвращаем выделение текста во время движения
                            isDragging = true;
                            const x = e.pageX - slider.offsetLeft, y = e.pageY - slider.offsetTop;
                            slider.scrollLeft = scrollLeft - (x - startX) * 1.5;
                            slider.scrollTop = scrollTop - (y - startY) * 1.5;
                        }});
                        slider.addEventListener('mouseup', () => {{ isDown = false; slider.style.cursor = 'grab'; }});
                        slider.addEventListener('mouseleave', () => {{ isDown = false; slider.style.cursor = 'grab'; }});
                    }});

                    document.addEventListener('click', function(e) {{
                        if(isDragging) return;
                        const node = e.target.closest('.flow-node-clickable');
                        // Если кликнули на ссылку ВНУТРИ ноды, не открываем модалку, пусть человек перейдет по ссылке
                        if(node && !e.target.closest('a') && !node.closest('.flow-map-expanded')) {{
                            const data = JSON.parse(decodeURIComponent(escape(atob(node.getAttribute('data-info')))));
                            document.getElementById('flow-modal-title').innerText = '🎯 ' + data.title;
                            document.getElementById('flow-modal-body').innerHTML = data.html || '<i style="color:#94a3b8;">Нет детальных условий</i>';
                            document.getElementById('flow-modal').style.display = 'flex';
                        }}
                    }});

                    document.getElementById('flow-modal').addEventListener('click', function(e) {{
                        if(e.target === this) this.style.display = 'none';
                    }});
                }})();
            }}
            </script>
            """
        return ""
    
    def render_audited_label_html(self, label_name, data, brand_id, labels_store, visited=None, target_utm=None, custom_badge="", custom_class="", node_type="", full_node_text="", is_nested=False, expected_data=None):
        # ⚡ ФИКС UX: Если это лейбл верхнего уровня (не внутри другого лейбла), сбрасываем кэш посещений.
        # Теперь каждый лейбл в письме/пуше будет рендериться как полноценная карточка!
        if visited is None or not is_nested: 
            visited = set()
            
        def esc(t): return str(t).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')
        
        clean_lbl = self.normalize_label_name(label_name)
        if not clean_lbl: return ""

        # 🤖 УМНЫЙ АНАЛИЗАТОР НАЗВАНИЯ
        lbl_type_id, lbl_type_name = self.guess_label_category(label_name)
        if lbl_type_name:
            custom_badge += f"<span style='background:#f3e8ff; color:#7e22ce; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:bold; border:1px solid #e9d5ff;' title='Определено по названию макроса'>🤖 {lbl_type_name}</span>"
        
        data = data or labels_store.get(label_name) or labels_store.get(clean_lbl)
        
        # ⚡ БЛОКИРУЕМ СЕТЬ. Если нет в кэше - моментально отдаем ошибку.
        if not data: 
            return f"<div style='color:#c0392b; margin-bottom:4px;'>❌ {esc(label_name)} (Not Found)</div>"
                
        # Защита только от бесконечной рекурсии (когда Макрос А ссылается на Макрос Б, а Макрос Б на Макрос А)
        if clean_lbl in visited: 
            return f"<div style='background: #f8fafc; border: 1px solid #e2e8f0; color: #64748b; padding: 4px 8px; border-radius: 6px; font-size: 11px; margin: 2px 4px 2px 0; display: inline-block;'>🔗 <b>{esc(label_name)}</b> (цикличная вложенность)</div>"
        
        visited.add(clean_lbl)
        
        tag_id = data.get("id")
        label_url = f"https://{self.drive_host}/{brand_id}#/labels_tags/{tag_id}"
        is_terms = any(x in label_name.lower() for x in ["term", "tnc", "policy", "rule"])
        default_val = str(data.get('default', ''))
        
        if is_terms:
            for trash in self.TRASH_STRINGS: default_val = default_val.replace(trash, "")
                
        tag_type_name = data.get('tag_type_name', 'Static text')
        tag_type_lower = str(tag_type_name).strip().lower()
        is_js_type = tag_type_lower == "javascript function"
        variations_list = data.get("variations", [])
        
        is_massive_html = len(default_val) > 15000 or any(len(str(v.get("tag_value", ""))) > 15000 for v in variations_list)
        
        has_js_snippet = False
        looks_like_translations = False
        
        if not is_massive_html or is_js_type:
            combined_text_for_js_check = default_val + " " + " ".join([str(v.get("tag_value", "")) for v in variations_list])
            search_area = combined_text_for_js_check[:20000]
            has_js_snippet = bool(re.search(r'\(\s*function\s*\([^\)]*\)\s*\{', search_area))
            looks_like_translations = bool(re.search(r'["\'][A-Z]{2}(-[A-Za-z]{2})?["\']\s*:', search_area))
        else:
            combined_text_for_js_check = default_val
            
        is_js_logic = is_js_type or has_js_snippet or looks_like_translations

        def parse_js_to_dict(js_text):
            # ⚡ ФИКС БЭКТРЕКИНГА: Ультра-быстрая регулярка без зависаний. Работает за 0.001с.
            dp = re.compile(r'(?:["\']([A-Z]{2}(?:-[A-Za-z]{2})?)["\']|([A-Z]{2}(?:-[A-Za-z]{2})?))\s*:\s*(["\'`])(.*?)(?<!\\)\3', re.IGNORECASE | re.DOTALL)
            sp = re.compile(r'case\s+["\']([A-Z]{2}(?:-[A-Za-z]{2})?)["\']\s*:\s*(?:return\s+)?(["\'`])(.*?)(?<!\\)\2', re.IGNORECASE | re.DOTALL)
            parsed = defaultdict(dict)
            bsplits = re.split(r'["\']([A-Za-z0-9_-]+)["\']\s*:\s*\{', js_text)
            if len(bsplits) >= 3:
                for i in range(1, len(bsplits), 2):
                    for m in dp.finditer(bsplits[i+1]):
                        lng = (m.group(1) or m.group(2)).upper()
                        if lng in self.FLAGS or (len(lng)>2 and lng[:2] in self.FLAGS): parsed[bsplits[i]][lng] = m.group(4)
            else:
                for m in dp.finditer(js_text):
                    lng = (m.group(1) or m.group(2)).upper()
                    if lng in self.FLAGS or (len(lng)>2 and lng[:2] in self.FLAGS): parsed["Global"][lng] = m.group(4)
                for m in sp.finditer(js_text):
                    lng = m.group(1).upper()
                    if lng in self.FLAGS or (len(lng)>2 and lng[:2] in self.FLAGS): parsed["Global"][lng] = m.group(3)
            return parsed

        warnings_html = ""
        if has_js_snippet and not is_js_type:
            warnings_html += f"<div class='critical-error-flag' style='background: #fef2f2; border: 1px solid #fca5a5; color: #b91c1c; padding: 10px 14px; border-radius: 8px; font-size: 13px; font-weight: bold; margin-bottom: 8px;'>🚨 Ошибка типа: В тексте JS-код, но тип в API равен «{esc(tag_type_name)}». Скрипт не отработает!</div>"
        elif not has_js_snippet and is_js_type and not is_massive_html:
            warnings_html += f"<div class='critical-error-flag' style='background: #fef2f2; border: 1px solid #fca5a5; color: #b91c1c; padding: 10px 14px; border-radius: 8px; font-size: 13px; font-weight: bold; margin-bottom: 8px;'>🚨 Ошибка типа: Тип лейбла JavaScript function, но внутри обычный статический текст.</div>"

        if is_js_logic:
            parsed_data = parse_js_to_dict(combined_text_for_js_check)
            
            global_sims = 0
            global_crit_count = 0
            global_warn_count = 0
            brand_results = []
            
            syntax_cache = {}
            
            for brand_name, translations in list(parsed_data.items()):
                if not translations: continue
                
                baseline_lang = "EN" if "EN" in translations else next((l for l, t in translations.items() if '{{label.' in t), None)
                baseline_counts, baseline_total = Counter(), 0
                if baseline_lang:
                    baseline_labels = re.findall(r'\{\{label\.[^\s\}]+\}\}', translations[baseline_lang])
                    baseline_counts, baseline_total = Counter(baseline_labels), len(baseline_labels)
                
                brand_pills = []
                brand_severity = 0 
                
                for lang_key, text_val in list(translations.items()):
                    crit_errs, warn_errs = [], []
                    
                    if baseline_lang and lang_key != baseline_lang:
                        labels_in_text = re.findall(r'\{\{label\.[^\s\}]+\}\}', text_val)
                        counts, total = Counter(labels_in_text), len(labels_in_text)
                        if counts != baseline_counts or total != baseline_total:
                            missing, extra = baseline_counts - counts, counts - baseline_counts
                            if total != baseline_total: crit_errs.append(f"Всего лейблов: <b>{total}</b> (ожидалось {baseline_total} как в {baseline_lang})")
                            if missing: crit_errs.append(f"Отсутствуют: {', '.join([f'<code>{esc(k)}</code> (x{v})' for k, v in missing.items()])}")
                            if extra: crit_errs.append(f"Лишние: {', '.join([f'<code>{esc(k)}</code> (x{v})' for k, v in extra.items()])}")

                    cache_key = (text_val, is_js_type)
                    if cache_key not in syntax_cache:
                        syntax_cache[cache_key] = self.validate_label_syntax(text_val, ignore_formatting_tags=not is_js_type)
                        
                    syntax_res = syntax_cache[cache_key]
                    crit_errs.extend(syntax_res["critical"])
                    warn_errs.extend(syntax_res["warning"])

                    if '{' in text_val:
                        glued = [f"<code>{esc(m.group(1) + m.group(2))}</code>" for m in re.finditer(r'([^\W_])(\{\{label\.[^\}]+\}\})', text_val) if m.group(2) not in ["{{label.highlight_font}}", "{{label.highlight_font_end}}"]]
                        for m in re.finditer(r'(\{\{label\.[^\}]+\}\})([^\W_])', text_val):
                            if lang_key != "KO" and m.group(1) not in ["{{label.highlight_font}}", "{{label.highlight_font_end}}"]:
                                glued.append(f"<code>{esc(m.group(1) + m.group(2))}</code>")
                        if glued: warn_errs.append(f"Лейбл слипся с текстом: {', '.join(glued)}")
                        
                    if node_type == "Email":
                        exc_cnt = text_val.count('!')
                        if exc_cnt > 1: warn_errs.append(f"В тексте {exc_cnt} знаков «!» (спам-риск).")

                    sim_type, max_limit, field_name = None, None, ""
                    lbl_lower = label_name.lower()
                    
                    # ⚡ ФИКС 1: СМС-лейблы часто называются без слова 'text' (например, 'choose_promo_sms'). 
                    # Теперь проверяем всё, что не является ссылкой!
                    if node_type == "SMS" and not any(x in lbl_lower for x in ['utm', 'link', 'url']):
                        sim_type, field_name = "SMS", "SMS"
                    elif node_type in ["Push", "Push PWA", "WebHook"]:
                        if "title" in lbl_lower or "head" in lbl_lower: sim_type, field_name, max_limit = "Push", "Title", 27
                        elif "text" in lbl_lower or "body" in lbl_lower or "msg" in lbl_lower or "message" in lbl_lower or "sms" in lbl_lower: sim_type, field_name, max_limit = "Push", "Text/Body", 75
                    elif node_type == "Pop-up":
                        if "title" in lbl_lower or "head" in lbl_lower: sim_type, field_name, max_limit = "Pop-up", "Title", 30
                        elif "text" in lbl_lower or "body" in lbl_lower or "msg" in lbl_lower or "message" in lbl_lower or "sub_title" in lbl_lower: sim_type, field_name, max_limit = "Pop-up", "Text (sub_title)", 130

                    simulated_text = text_val
                    sim_len = len(simulated_text)
                    is_excluded = False
                    parts, encoding = 1, "N/A"

                    if sim_type:
                        global_sims += 1
                        
                        if sim_type == "SMS":
                            template_text = str(full_node_text) if full_node_text else label_name
                            
                            def primary_replacer(match):
                                if self.normalize_label_name(match.group(0)) == clean_lbl:
                                    return str(text_val)
                                return match.group(0)
                                
                            sim_temp = re.sub(r'\{\{[^\}]+\}\}', primary_replacer, template_text)
                            simulated_text = text_val if sim_temp == template_text else sim_temp
                        else:
                            simulated_text = text_val
                        
                        def resolve_macro_value(macro_key, target_lang, target_brand):
                            key_lower = macro_key.lower()
                            if not key_lower.startswith('{{label.') and not key_lower.startswith('{{bns_'): return "5000"
                            if self.is_ignored_label(macro_key): return "5000"
                            clean_mac = self.normalize_label_name(macro_key)
                            if not clean_mac: return "5000"
                            
                            # ⚡ ФИКС 2: Гарантируем, что макрос скачивается, если его нет или это просто строка
                            if clean_mac not in labels_store or not isinstance(labels_store.get(clean_mac), dict) or "default" not in labels_store.get(clean_mac):
                                fetched = self.get_label_data_with_variations(clean_mac)
                                if fetched: labels_store[clean_mac] = fetched
                                
                            m_data = labels_store.get(clean_mac)
                            if not isinstance(m_data, dict): return "5000"
                            
                            m_type = str(m_data.get("tag_type_name", "")).strip().lower()
                            m_def = str(m_data.get("default", ""))
                            variations = m_data.get("variations", [])
                            
                            if "_parsed_js" not in m_data:
                                m_comb = m_def + " " + " ".join([str(v.get("tag_value", "")) for v in variations])
                                if m_type == "javascript function" or bool(re.search(r'["\'][A-Z]{2}(-[A-Za-z]{2})?["\']\s*:', m_comb)):
                                    m_data["_parsed_js"] = parse_js_to_dict(m_comb)
                                else:
                                    m_data["_parsed_js"] = None
                            
                            u_parsed = m_data["_parsed_js"]
                            if u_parsed:
                                if target_brand in u_parsed and target_lang in u_parsed[target_brand]: return str(u_parsed[target_brand][target_lang])
                                if "Global" in u_parsed and target_lang in u_parsed["Global"]: return str(u_parsed["Global"][target_lang])
                                if "Global" in u_parsed and "EN" in u_parsed["Global"]: return str(u_parsed["Global"]["EN"])
                                for b in u_parsed:
                                    if u_parsed[b]: return str(list(u_parsed[b].values())[0])
                                    
                            matched_val = None
                            for v in variations:
                                cond = str(v.get("conditions_readable", "")).upper()
                                if target_brand.upper() != "GLOBAL" and target_brand.upper() in cond:
                                    matched_val = str(v.get("tag_value", ""))
                                    break
                            if matched_val is None:
                                for v in variations:
                                    cond = str(v.get("conditions_readable", "")).upper()
                                    if f"({target_lang.upper()})" in cond or f" {target_lang.upper()} " in cond or cond.endswith(target_lang.upper()) or f"_{target_lang.upper()}" in cond or f"'{target_lang.upper()}'" in cond:
                                        matched_val = str(v.get("tag_value", ""))
                                        break
                            if matched_val is None and m_def.strip(): matched_val = m_def
                            if matched_val is None and variations:
                                for v in variations:
                                    if str(v.get("tag_value", "")).strip(): matched_val = str(v.get("tag_value", "")).strip(); break
                            
                            res_val = str(matched_val) if matched_val is not None else "5000"
                            return re.sub(r'<[^>]+>', '', res_val).strip() or "5000"

                        BRAND_MAP = {"673": "Winaura", "822": "Casinacho", "828": "Goldzino", "678": "R2PBet", "651": "Kinghills", "842": "Winbeatz", "645": "Ninewin", "896": "AFKspin", "829": "Oscarspin", "839": "Spingranny", "836": "Corgibet", "869": "Spinjoys", "885": "Lootzino", "904": "Senseizino"}
                        real_brand_name = BRAND_MAP.get(str(brand_id), brand_name)

                        max_depth = 3
                        while max_depth > 0:
                            macros_to_replace = set(re.findall(r'\{\{[^\}]+\}\}', simulated_text))
                            if not macros_to_replace: break
                            for macro in macros_to_replace:
                                simulated_text = simulated_text.replace(macro, resolve_macro_value(macro, lang_key, real_brand_name))
                            max_depth -= 1

                        simulated_text = simulated_text.replace('&nbsp;', ' ').strip()
                        sim_len = len(simulated_text)
                        is_excluded = (sim_type == "SMS") and (lang_key in ["BG", "MK", "KO", "EL"])
                        
                        if sim_type == "SMS":
                            gsm7_chars = set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€")
                            non_gsm7 = set(c for c in simulated_text if c not in gsm7_chars)
                            encoding = "UCS-2" if non_gsm7 else "GSM-7"
                            parts = (sim_len // 153) + (1 if sim_len % 153 else 0) if encoding == "GSM-7" else (sim_len // 67) + (1 if sim_len % 67 else 0)
                            if parts == 0: parts = 1

                        if not is_excluded:
                            if sim_type == "SMS":
                                if parts > 1:
                                    limit = 160 if encoding == "GSM-7" else 70
                                    crit_errs.append(f"🚨 ДВОЙНАЯ СМС: ~{sim_len} симв. (<b>{parts} SMS</b> в {encoding}, макс для 1: {limit})")
                            elif sim_type in ["Push", "Pop-up"]:
                                if sim_len > max_limit: crit_errs.append(f"🚨 ПРЕВЫШЕН ЛИМИТ ({field_name}): ~{sim_len} симв. (макс {max_limit})")

                    if not sim_type and not crit_errs and not warn_errs:
                        continue

                    clean_errs = [re.sub(r'<[^>]+>', '', e) for e in (crit_errs + warn_errs)]
                    data_details = " | ".join(clean_errs).replace('"', '&quot;').replace("'", "&#39;")
                    hover_text = esc(simulated_text).replace('"', '&quot;').replace("'", "&#39;")
                    
                    # ⚡️ КАТЕГОРИЗАТОР ОШИБОК ДЛЯ ПЛАШЕК
                    err_cats = set()
                    joined_errs = " ".join(clean_errs).lower()
                    if any(x in joined_errs for x in ["длина", "превышен лимит", "двойная смс", "симв."]): err_cats.add("Длина")
                    if any(x in joined_errs for x in ["макросов", "отсутствуют", "лишние", "лейблов"]): err_cats.add("Макросы")
                    if any(x in joined_errs for x in ["сломанные", "опечатка", "скобки", "решеток", "знаков @", "пробел", "слипся", "ошибка типа"]): err_cats.add("Синтаксис")
                    if "ucs-2" in joined_errs: err_cats.add("Кодировка")
                    err_title = ", ".join(sorted(list(err_cats))) if err_cats else "Дефекты"
                    
                    if is_excluded and sim_type:
                        pill_class = "pill-gray"
                        summary_text = f"Исключено (~{sim_len} симв.)"
                        err_html = "<i>Исключено из рассылки</i>"
                    elif crit_errs:
                        pill_class = "pill-red"
                        # Вставляем категорию ошибки прямо в заголовок
                        summary_text = f"{err_title} (~{sim_len} симв.)" if sim_type else f"{err_title}"
                        brand_severity = max(brand_severity, 2)
                        global_crit_count += 1
                        err_html = "<br>".join([f"<span style='color:#b91c1c; font-weight:bold;'>• {esc(e)}</span>" for e in crit_errs])
                        if warn_errs: err_html += "<br>" + "<br>".join([f"<span style='color:#b45309;'>• {esc(e)}</span>" for e in warn_errs])
                    elif warn_errs:
                        pill_class = "pill-yellow"
                        summary_text = f"Замечание [{err_title}] (~{sim_len} симв.)" if sim_type else f"ЗАМЕЧАНИЕ [{err_title}]"
                        brand_severity = max(brand_severity, 1)
                        global_warn_count += 1
                        err_html = "<br>".join([f"<span style='color:#b45309; font-weight:bold;'>• {esc(e)}</span>" for e in warn_errs])
                    else:
                        pill_class = "pill-green"
                        summary_text = f"Идеально (~{sim_len} симв.)"
                        err_html = "<span style='color:#15803d; font-weight:bold;'>Идеально! Ошибок нет.</span>"
                        
                    copy_class = "copyable-error" if (crit_errs or warn_errs) else ""
                    crit_flag = "critical-error-flag" if crit_errs else ""

                    pill_html = f"""
                    <details class="sim-pill {pill_class} {copy_class} {crit_flag}" data-macro='{esc(label_name)}' data-brand='{esc(brand_name)}' data-lang='{esc(lang_key)}' data-details="{data_details}">
                        <summary>
                            <b>{esc(lang_key)}</b> <span style="font-weight:normal; opacity:0.8;">{summary_text}</span>
                            <span class="custom-tooltip">{hover_text}</span>
                        </summary>
                        <div class="sim-pill-content">
                            <div style="margin-bottom:8px;">{err_html}</div>
                            <div style="padding:8px; background:rgba(0,0,0,0.03); border-radius:4px; border:1px solid rgba(0,0,0,0.05); color:#334155; font-family:monospace;">{esc(simulated_text)}</div>
                        </div>
                    </details>
                    """
                    brand_pills.append(pill_html)
                    
                if brand_pills:
                    if brand_severity == 2: b_bg, b_border, b_color, b_icon = "#fef2f2", "#ef4444", "#991b1b", "🚨"
                    elif brand_severity == 1: b_bg, b_border, b_color, b_icon = "#fffbeb", "#f59e0b", "#92400e", "⚠️"
                    else: b_bg, b_border, b_color, b_icon = "#f8fafc", "#cbd5e1", "#1e293b", "✅"
                    
                    b_class = "brand-has-errors" if brand_severity > 0 else "brand-perfect"
                        
                    brand_html = f"""
                    <div class='{b_class}' style='margin-bottom:12px; background:{b_bg}; border:1px solid #e2e8f0; border-left:4px solid {b_border}; border-radius:6px; padding:12px; box-shadow:0 1px 2px rgba(0,0,0,0.02);'>
                        <div style='font-weight:bold; color:{b_color}; font-size:13px; margin-bottom:8px; display:flex; align-items:center; gap:6px;'>{b_icon} Бренд: {esc(brand_name)}</div>
                        <div>{''.join(brand_pills)}</div>
                    </div>
                    """
                    brand_results.append((brand_severity, brand_name, brand_html))

            brand_results.sort(key=lambda x: (-x[0], x[1]))
            all_brands_html = "".join([x[2] for x in brand_results])
            
            lbl_lower = label_name.lower()
            is_sms_sim = node_type == "SMS" and "text" in lbl_lower
            is_push_sim = node_type in ["Push", "Push PWA", "WebHook", "Pop-up"] and ("title" in lbl_lower or "head" in lbl_lower or "text" in lbl_lower or "body" in lbl_lower or "message" in lbl_lower or "msg" in lbl_lower or "sub_title" in lbl_lower)

            sim_name = "SMS" if is_sms_sim else "Push / PWA / Webhook / Pop-up"
            sim_msg = f" ({sim_name}) вписываются в лимиты и" if (is_sms_sim or is_push_sim) and global_sims > 0 else ""
            sim_err_msg = f" ({sim_name})" if (is_sms_sim or is_push_sim) and global_sims > 0 else ""

            if global_crit_count == 0 and global_warn_count == 0 and not warnings_html:
                warnings_html += f"<div style='margin-bottom:12px; padding:10px 14px; background:#dcfce7; color:#166534; border-left:4px solid #22c55e; border-radius:6px; font-size:13px; font-weight:500; box-shadow:0 1px 2px rgba(0,0,0,0.05);'><b>✅ Идеально!</b> Все вариации{sim_msg} не содержат синтаксических ошибок.</div>"
            elif global_crit_count > 0:
                warnings_html += f"<div style='margin-bottom:12px; padding:10px 14px; background:#fef2f2; color:#991b1b; border-left:4px solid #ef4444; border-radius:6px; font-size:13px; font-weight:500; box-shadow:0 1px 2px rgba(0,0,0,0.05);'><b>🛑 Найдено критических ошибок: {global_crit_count}</b>{sim_err_msg}. Раскройте красные бренды ниже для просмотра деталей.</div>"
            elif global_warn_count > 0:
                warnings_html += f"<div style='margin-bottom:12px; padding:10px 14px; background:#fffbeb; color:#92400e; border-left:4px solid #f59e0b; border-radius:6px; font-size:13px; font-weight:500; box-shadow:0 1px 2px rgba(0,0,0,0.05);'><b>⚠️ Найдены замечания: {global_warn_count}</b>{sim_err_msg}. Обратите внимание на желтые бренды ниже.</div>"

            warnings_html += all_brands_html

        vars_rows_list = []
        if not is_js_logic:
            syntax_res = self.validate_label_syntax(default_val, ignore_formatting_tags=True)
            crit_errs = syntax_res["critical"]
            warn_errs = syntax_res["warning"]
            
            if crit_errs or warn_errs:
                clean_errs = [re.sub(r'<[^>]+>', '', e) for e in (crit_errs + warn_errs)]
                data_details = " | ".join(clean_errs).replace('"', '&quot;').replace("'", "&#39;")
                
                err_html_lines = []
                if crit_errs:
                    err_html_lines.append(f"<div style='color:#b91c1c; font-weight:bold; margin-bottom:4px;'>🛑 Критические ошибки:</div>")
                    err_html_lines.append('<br>'.join(['<span style="color:#b91c1c; font-weight:500;">• '+e+'</span>' for e in crit_errs]))
                if warn_errs:
                    if crit_errs: err_html_lines.append("<div style='height:8px;'></div>")
                    err_html_lines.append(f"<div style='color:#b45309; font-weight:bold; margin-bottom:4px;'>⚠️ Замечания (Warnings):</div>")
                    err_html_lines.append('<br>'.join(['<span style="color:#b45309; font-weight:500;">• '+e+'</span>' for e in warn_errs]))
                err_html = "".join(err_html_lines)
                
                if crit_errs:
                    warnings_html += f"<div class='copyable-error critical-error-flag' data-macro='{esc(label_name)}' data-brand='Global' data-lang='Default Text' data-details='{data_details}' style='background: #fef2f2; border: 1px solid #fca5a5; color: #b91c1c; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 8px;'>{err_html}</div>"
                else:
                    warnings_html += f"<div class='copyable-error' data-macro='{esc(label_name)}' data-brand='Global' data-lang='Default Text' data-details='{data_details}' style='background: #fff3cd; border: 1px solid #f39c12; color: #856404; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 8px;'>{err_html}</div>"
            elif not warnings_html:
                warnings_html += f"<div style='margin-bottom:12px; padding:10px 14px; background:#dcfce7; color:#166534; border-left:4px solid #22c55e; border-radius:6px; font-size:13px; font-weight:500; box-shadow:0 1px 2px rgba(0,0,0,0.05);'><b>✅ Идеально!</b> Синтаксических ошибок не найдено.</div>"
        
        if has_js_snippet or len(default_val) > 250:
            default_display = f"<div style='max-height: 500px; overflow-y: auto; padding-right: 5px;'>{esc(default_val)}</div>"
        else:
            default_display = esc(default_val) if default_val.strip() else "<i style='color:#94a3b8;'>(Empty)</i>"
            
        should_check_mismatch = is_terms or tag_type_lower == "javascript function"
        default_labels = set(re.findall(r'\{\{label\.[^\s\}]+\}\}', default_val)) if should_check_mismatch else set()
        
        label_mismatch_warnings = []
        combined_text_for_nested = default_val
        len_vars = len(variations_list)
        
        local_syntax_cache = {}
        vars_rows_list = []
        
        for idx, v in enumerate(variations_list):
            cond_str, val = self.inject_flags(v.get("conditions_readable") or ""), str(v.get("tag_value") or "")
            
            if is_terms:
                for trash in self.TRASH_STRINGS: val = val.replace(trash, "")
                
            if should_check_mismatch:
                var_labels = set(re.findall(r'\{\{label\.[^\s\}]+\}\}', val))
                missing, extra = default_labels - var_labels, var_labels - default_labels
                
                if missing or extra:
                    mismatch_msg = []
                    if missing: mismatch_msg.append(f"Отсутствуют: {', '.join(missing)}")
                    if extra: mismatch_msg.append(f"Лишние: {', '.join(extra)}")
                    label_mismatch_warnings.append(f"В условии <b>{esc(cond_str)}</b>: {' | '.join(mismatch_msg)}")
                    
            val_display = f"<div style='max-height:400px; overflow-y:auto;'>{esc(val)}</div>" if has_js_snippet or len(val) > 250 else (esc(val) if val.strip() else "<i style='color:#94a3b8;'>(Empty)</i>")
            
            # 🤖 АНАЛИЗ СОДЕРЖИМОГО (СВЕРКА С ТАБЛИЦЕЙ)
            if lbl_type_id and expected_data:
                is_valid, exp_vals = self.validate_offer_value(lbl_type_id, val, expected_data)
                exp_str = ", ".join(exp_vals)
                if is_valid is True:
                    val_display += f"<div style='margin-top:6px; font-size:11px; font-weight:bold; color:#15803d; background:#dcfce7; padding:4px 8px; border-radius:4px; border:1px solid #86efac; display:inline-block;'>✅ Совпадает с планом ({exp_str})</div>"
                elif is_valid is False:
                    val_display += f"<div style='margin-top:6px; font-size:11px; font-weight:bold; color:#991b1b; background:#fef2f2; padding:4px 8px; border-radius:4px; border:1px solid #fca5a5; display:inline-block;'>❌ Расхождение! Ожидалось: {exp_str}</div>"
                    warn_errs.append(f"Значение '{val}' не совпадает с промо-планом (Ожидалось: {exp_str})")

            is_js_type = tag_type_lower == "javascript function"
            
            cache_key = (val, is_js_type)
            if cache_key not in local_syntax_cache:
                local_syntax_cache[cache_key] = self.validate_label_syntax(val, ignore_formatting_tags=not is_js_type)
                
            syntax_res = local_syntax_cache[cache_key]
            crit_errs = syntax_res["critical"]
            warn_errs = syntax_res["warning"]
            
            if crit_errs or warn_errs:
                clean_errs = [re.sub(r'<[^>]+>', '', e) for e in (crit_errs + warn_errs)]
                data_details = " | ".join(clean_errs).replace('"', '&quot;').replace("'", "&#39;")
                
                err_html_lines = []
                if crit_errs:
                    err_html_lines.append(f"<div style='color:#b91c1c; font-weight:bold; margin-bottom:4px;'>🛑 Критические ошибки:</div>")
                    err_html_lines.append('<br>'.join(['<span style="color:#b91c1c; font-weight:500;">• '+e+'</span>' for e in crit_errs]))
                if warn_errs:
                    if crit_errs: err_html_lines.append("<div style='height:8px;'></div>")
                    err_html_lines.append(f"<div style='color:#b45309; font-weight:bold; margin-bottom:4px;'>⚠️ Замечания (Warnings):</div>")
                    err_html_lines.append('<br>'.join(['<span style="color:#b45309; font-weight:500;">• '+e+'</span>' for e in warn_errs]))
                err_html = "".join(err_html_lines)
                
                if crit_errs:
                    val_display += f"<div class='copyable-error critical-error-flag' data-macro='{esc(label_name)}' data-brand='Variation' data-lang='{esc(cond_str)}' data-details='{data_details}' style='background: #fef2f2; border: 1px solid #fca5a5; color: #b91c1c; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-top: 8px; margin-bottom: 8px;'>{err_html}</div>"
                else:
                    val_display += f"<div class='copyable-error' data-macro='{esc(label_name)}' data-brand='Variation' data-lang='{esc(cond_str)}' data-details='{data_details}' style='background: #fff3cd; border: 1px solid #f39c12; color: #856404; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-top: 8px; margin-bottom: 8px;'>{err_html}</div>"
            
            c_up = cond_str.upper()
            r_match, o_match = any(k in c_up for k in ["RKMDAYLI_BOTTOM_1", "RKMDAYLI_VERY LOW_2", "RKMDAYLI_LOW_3", "RKMDAYLI_MEDIUM_4"]), any(k in c_up for k in ["RKMDAYLI_HIGH_5", "RKMDAYLI_VERY HIGH_6"])
            b_match, p_match = any(k in c_up for k in ["RKMDAYLI_VIP 2_8", "RKMDAYLI_VIP 3_9", "RKMDAYLI_VIP 4_10"]), "RKMDAYLI_VIP" in c_up and not any(k in c_up for k in ["RKMDAYLI_VIP 2_8", "RKMDAYLI_VIP 3_9", "RKMDAYLI_VIP 4_10"])
            br_match = "REGISTRATION COUNTRY' IS ONE OF (BR)" in c_up
            matches = sum([r_match, o_match, b_match, p_match])
            bg_style = "background: linear-gradient(90deg, #d1fae5 0%, #fef08a 100%); color: #065f46;" if br_match else f"background: {'#fff9c4' if idx % 2 == 0 else '#bbdefb'}; color: #111827;" if matches > 1 else "background: #fee2e2; color: #7f1d1d;" if r_match else "background: #ffedd5; color: #9a3412;" if o_match else "background: #dbeafe; color: #1e3a8a;" if b_match else "background: #f3e8ff; color: #581c87;" if p_match else f"background: {'#fff9c4' if idx % 2 == 0 else '#bbdefb'}; color: #111827;"
                
            vars_rows_list.append(f"<tr style='{bg_style}'><td style='border:1px solid #D1D5DB; padding:10px;'>{esc(cond_str)}</td><td style='border:1px solid #D1D5DB; padding:10px; font-family:monospace; word-break:break-all;'>{val_display}</td></tr>")

        vars_rows = "".join(vars_rows_list)

        if label_mismatch_warnings:
            clean_mismatches = [re.sub(r'<[^>]+>', '', m) for m in label_mismatch_warnings]
            data_details = " | ".join(clean_mismatches).replace('"', '&quot;').replace("'", "&#39;")
            warnings_html += f"<div class='copyable-error critical-error-flag' data-macro='{esc(label_name)}' data-brand='Global' data-lang='Default Mismatch' data-details='{data_details}' style='background: #fef2f2; border: 1px solid #fca5a5; color: #b91c1c; padding: 10px 14px; border-radius: 8px; font-size: 13px; font-weight: bold; margin-bottom: 8px;'>🚨 Расхождение с Default Value:<br>{'<br>'.join(label_mismatch_warnings)}</div>"

        scrollable_warnings = f"<div style='margin-bottom: 16px;'>{warnings_html}</div>" if warnings_html else ""

        nested_labels = sorted([l for l in set(re.findall(r'\{\{label\.[^\s\}]+\}\}', combined_text_for_nested)) if not self.is_ignored_label(l)])
        nested_html = ""
        if nested_labels:
            nested_html += "<div style='margin-top: 10px; padding: 10px; border-left: 3px dashed #bdc3c7; background: #fdfefe; border-radius: 0 4px 4px 0;'><b style='font-size: 12px; color: #7f8c8d; margin-bottom: 8px; display: block;'>🔗 Вложенные лейблы:</b>"
            for n_lbl in nested_labels: nested_html += self.render_audited_label_html(n_lbl, labels_store.get(n_lbl), brand_id, labels_store, visited, None, node_type=node_type, full_node_text=full_node_text, is_nested=True, expected_data=expected_data)
            nested_html += "</div>"

        # ⚡ Сначала проверяем короткие ссылки (чтобы знать статус UTM)
        sms_links_html = ""
        sms_has_links = False
        sms_utm_found = False
        if node_type == "SMS" and target_utm:
            all_label_values = [default_val] + [str(v.get("tag_value", "")) for v in variations_list]
            sms_links_html, sms_has_links, sms_utm_found = self._check_sms_shortlinks(all_label_values, target_utm)

        # ⚡ Теперь формируем бейджик с учетом результатов HTTP-проверки
        if node_type == "SMS" and sms_has_links:
            if sms_utm_found:
                utm_status = "<span style='background:#dcfce7; color:#15803d; padding:2px 8px; border-radius:12px; font-size:11px;'>✅ UTM-метка найдена (в Short-link)</span>"
            else:
                utm_status = "<span style='background:#fee2e2; color:#b91c1c; padding:2px 8px; border-radius:12px; font-size:11px;'>❌ UTM-метка не найдена (в Short-link)</span>"
        else:
            utm_status = "<span style='background:#dcfce7; color:#15803d; padding:2px 8px; border-radius:12px; font-size:11px;'>✅ UTM-метка найдена</span>" if target_utm and data and target_utm in str(data.get('default', '')) else "<span style='background:#fee2e2; color:#b91c1c; padding:2px 8px; border-radius:12px; font-size:11px;'>❌ UTM-метка не найдена</span>" if target_utm and data else ""
        
        has_any_errors = 'copyable-error' in scrollable_warnings or 'copyable-error' in vars_rows
        has_critical = 'critical-error-flag' in scrollable_warnings or 'critical-error-flag' in vars_rows
        
        copy_btns = ""
        if has_any_errors:
            copy_btns += "<div style='display:flex; gap:10px; margin-bottom:12px;'>"
            if has_critical:
                copy_btns += "<button onclick='copyLocalErrors(this, event, true)' class='px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded shadow-sm transition-colors' style='cursor:pointer; border:none;'>🚨 Copy Critical</button>"
            copy_btns += "<button onclick='copyLocalErrors(this, event, false)' class='px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold rounded shadow-sm transition-colors' style='cursor:pointer; border:none;'>📋 Copy All Errors</button>"
            copy_btns += "</div>"
            
        type_badge = f"<span style='background:#e2e8f0; color:#475569; padding:2px 8px; border-radius:12px; font-size:11px; margin-left:10px; font-weight:bold;'>🏷️ {esc(tag_type_name)}</span>"

        # 👇 ДОБАВЛЯЕМ ПЛАШКУ ВЛОЖЕННЫХ ЛЕЙБЛОВ СРАЗУ ПОСЛЕ ТИПА (STATIC TEXT)
        if nested_labels:
            type_badge += f"<span style='background:#fdfefe; color:#64748b; padding:2px 8px; border-radius:12px; font-size:11px; margin-left:6px; font-weight:bold; border:1px dashed #cbd5e1;' title='Содержит другие макросы внутри'>🪆 Вложенных: {len(nested_labels)}</span>"

        return f"""
            <details class="dim-target">
                <summary{' class="'+custom_class+'"' if custom_class else ''}>
                    <a href="{label_url}" target="_blank">{esc(label_name)}</a>{type_badge}{f"<div style='margin-left:auto; display:flex; gap:8px;'>{custom_badge}{utm_status}</div>" if (custom_badge or utm_status) else ""}
                </summary>
            <div style="padding-top: 12px;">
                {copy_btns}
                {scrollable_warnings}
                {sms_links_html} 
                <div style="margin-bottom: 16px; background: #F3F4F6; padding: 12px; border: 1px solid #D1D5DB; border-radius: 6px;">
                    <strong style="color: #374151; font-size: 12px; text-transform: uppercase;">Default Value:</strong>
                    <div style="margin-top: 6px; font-family: monospace; font-size: 13px; word-break: break-all;">{default_display}</div>
                </div>
                <table style="width: 100%; border-collapse: collapse; font-size:13px; border-radius: 6px; overflow: hidden; box-shadow: 0 0 0 1px #D1D5DB;">
                        <thead><tr style="background:#E5E7EB;"><th style="padding:10px; border-bottom:1px solid #D1D5DB; text-align:left; width:35%;">Conditions (Всего вариаций: {len_vars})</th><th style="padding:10px; border-bottom:1px solid #D1D5DB; text-align:left; width:65%;">Value</th></tr></thead>
                        <tbody>{vars_rows or '<tr><td colspan="2" style="padding:10px; text-align:center; color:#6B7280;">No variations</td></tr>'}</tbody>
                </table>
                {nested_html}
                <div style="margin-top: 15px; padding-top: 10px; border-top: 1px dashed #cbd5e1; text-align: right;">
                    <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: bold; color: #64748b; background: #f8fafc; padding: 6px 12px; border-radius: 6px; border: 1px solid #e2e8f0; transition: 0.2s;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f8fafc'">
                        <input type="checkbox" class="sync-cb" data-label="{esc(label_name)}" style="transform: scale(1.2);"> Отметить как проверенное
                    </label>
                </div>
            </div>
        </details>
        """

    def generate_push_pwa_comparison(self, deep_analysis):
        """Сравнивает контент Web Push, Push PWA и Web Hook, выдает HTML и карту цветов для пар"""
        
        def get_sig(node):
            return (str(node.get('body','')).strip(), str(node.get('title_url','')).strip(), str(node.get('link','')).strip(), str(node.get('subject','')).strip())

        def deduplicate(nodes):
            grouped = {}
            for n in nodes:
                sig = get_sig(n)
                if sig not in grouped:
                    nc = dict(n)
                    nc['node_names'] = [n['name']]
                    grouped[sig] = nc
                else:
                    if n['name'] not in grouped[sig]['node_names']:
                        grouped[sig]['node_names'].append(n['name'])
            res = list(grouped.values())
            for r in res:
                r['name'] = " / ".join(r['node_names'])
            return res

        pushes = deduplicate([item for item in deep_analysis if item.get('type') == 'Push'])
        pwas = deduplicate([item for item in deep_analysis if item.get('type') == 'Push PWA'])
        webhooks = deduplicate([item for item in deep_analysis if item.get('type') == 'WebHook'])
        
        VALID_BRAND_LINKS = ["{{label.crm2_brand_link}}", "{{label.brand_link}}", "{{label.crm_brand_link}}"]
        
        pair_colors = {}
        COLORS = ["#FF3B30", "#3498DB", "#00C853", "#F1C40F", "#9B59B6", "#FF9500", "#1ABC9C", "#FF2D55", "#34495E"]
        pair_idx = 0

        if not pushes and not pwas and not webhooks:
            return "", pair_colors
            
        html = """
        <h3 style='margin-top:30px; color:#8e44ad; border-bottom: 2px solid #8e44ad; padding-bottom:6px;'>🔁 Cross-Channel Consistency</h3>
        <div class="card dim-target" style="border-left-color: #8e44ad; background: #fcf3ff; padding-top: 15px; transition: 0.3s; display: flex; flex-direction: column;">
            <h4 style="margin: 0 0 15px 0; color:#2c3e50;">Анализ связей (Push / PWA / WebHook)</h4>
            <div>
        """
        
        def esc(t): return str(t).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')
        
        def make_link(node):
            name = esc(node.get('name') or 'Unknown')
            url = esc(node.get('email_url', '#'))
            if url != '#':
                return f"<a href='{url}' target='_blank' style='color: #2980b9; text-decoration: none; border-bottom: 1px dashed;'>{name}</a>"
            return f"<strong style='color: #34495e;'>{name}</strong>"

        # ВРЕМЕННО ОТКЛЮЧЕНО: Проверка ссылок (brand_link / cashier_link)

        # --- 2. Поиск пар Push и Push PWA ---
        html += """<h4 style="margin-top: 0; color: #2c3e50;">👯 Идентичность Web Push и Push PWA</h4>"""
        def get_core(node):
            return {"title": node.get('title_url') or "", "message": node.get('body') or "", "button": node.get('button1') or "", "image": node.get('image_url') or "", "icon": node.get('icon_url') or ""}
            
        def get_clean_link(node):
            link_str = node.get('link') or ""
            for b in VALID_BRAND_LINKS: link_str = link_str.replace(b, "")
            return link_str.strip()

        unmatched_pushes = list(pushes)
        unmatched_pwas = list(pwas)
        matched_pairs = []
        
        for push in pushes:
            p_name_html = make_link(push)
            p_core = get_core(push)
            has_cashier = "{{label.cashier_link}}" in (push.get('link') or "")
            p_clink = get_clean_link(push)
            
            match_found = False
            matched_pwa = None
            for pwa in unmatched_pwas:
                if p_core == get_core(pwa):
                    if has_cashier or p_clink == get_clean_link(pwa):
                        match_found = True
                        matched_pwa = pwa
                        break
                        
            if match_found:
                color = COLORS[pair_idx % len(COLORS)]
                pair_colors[get_sig(push)] = color
                pair_colors[get_sig(matched_pwa)] = color
                pair_idx += 1
                
                matched_pairs.append((p_name_html, make_link(matched_pwa), has_cashier, color))
                unmatched_pwas.remove(matched_pwa)
                unmatched_pushes.remove(push)
                
        html += "<ul style='font-family: monospace; font-size: 13px; color: #333; padding-left: 20px;'>"
        for p, pw, is_cashier, color in matched_pairs:
            note = " (Игнор ссылки из-за Кассы)" if is_cashier else ""
            dot = f"<span style='display:inline-block; width:12px; height:12px; border-radius:50%; background:{color}; margin-right:4px; box-shadow: 0 0 2px rgba(0,0,0,0.3);'></span>"
            html += f"<li style='margin-bottom: 4px; display: flex; align-items: center; gap: 4px;'>{dot} <span>✅ <strong>Совпадение{note}:</strong> [Web Push] {p} 🤝 [Push PWA] {pw}</span></li>"
            
        if len(unmatched_pushes) == 1 and len(unmatched_pwas) == 1:
            p, pw = unmatched_pushes[0], unmatched_pwas[0]
            c1, c2 = get_core(p), get_core(pw)
            diffs = [f"<b>{k.capitalize()}:</b> [{esc(c1[k])}] != [{esc(c2[k])}]" for k in ['title', 'message', 'button', 'image', 'icon'] if c1[k] != c2[k]]
            l1, l2 = get_clean_link(p), get_clean_link(pw)
            if l1 != l2: diffs.append(f"<b>Link:</b> [{esc(l1)}] != [{esc(l2)}]")
            html += f"<li style='margin-bottom: 4px; color: #c0392b;'>❌ <strong>Найдена дельта:</strong> [Web Push] {make_link(p)} vs [Push PWA] {make_link(pw)}<div style='margin-top:6px; padding:10px; background:#fadbd8; border-left:3px solid #c0392b; border-radius:4px; color:#900C3F; font-size:12px;'>{'<br>'.join(diffs)}</div></li>"
        else:
            for p in unmatched_pushes: html += f"<li style='margin-bottom: 4px; color: #c0392b;'>❌ <strong>Различия:</strong> [Web Push] {make_link(p)} не имеет точной копии среди PWA.</li>"
            for pw in unmatched_pwas: html += f"<li style='margin-bottom: 4px; color: #c0392b;'>❌ <strong>Различия:</strong> [Push PWA] {make_link(pw)} не имеет точной копии среди Web Push.</li>"
        html += "</ul>"

        # --- 3. Сравнение Push и Web Hook по лейблам ---
        html += """<h4 style="margin-top: 15px; color: #2c3e50;">🪝 Связь Web Push и Web Hook (Идентичность лейблов)</h4>"""
        html += "<ul style='font-family: monospace; font-size: 13px; color: #333; padding-left: 20px;'>"
        
        def get_labels_from_text(text):
            if not text: return set()
            labels = set(re.findall(r'\{\{label\.[^\s\}]+\}\}', text))
            return {l for l in labels if not self.is_ignored_label(l) and l not in VALID_BRAND_LINKS and l != "{{label.cashier_link}}"}

        matched_hook_pairs = []
        unmatched_hooks = []
        used_pushes = set() 
        
        for hook in webhooks:
            h_name_html = make_link(hook)
            h_text = f"{hook.get('title_url', '')} {hook.get('body', '')}"
            h_labels = get_labels_from_text(h_text)
                
            match_found = False
            matched_push = None
            for push in pushes:
                p_text = f"{push.get('title_url', '')} {push.get('body', '')} {push.get('link', '')} {push.get('button1', '')} {push.get('image_url', '')} {push.get('icon_url', '')}"
                p_labels = get_labels_from_text(p_text)
                
                if h_labels and h_labels.issubset(p_labels):
                    match_found = True
                    matched_push = push
                    break
                    
            if match_found:
                p_sig = get_sig(matched_push)
                h_sig = get_sig(hook)
                
                is_duplicate = p_sig in used_pushes
                used_pushes.add(p_sig)
                
                color = pair_colors.get(p_sig)
                if not color:
                    color = COLORS[pair_idx % len(COLORS)]
                    pair_idx += 1
                    pair_colors[p_sig] = color
                pair_colors[h_sig] = color
                
                matched_hook_pairs.append((make_link(matched_push), h_name_html, color, is_duplicate))
            else:
                unmatched_hooks.append(hook)

        if not pushes: html += "<li style='color: gray;'>Нет Web Push для сравнения.</li>"
        elif not webhooks: html += "<li style='color: gray;'>Нет Web Hook для сравнения.</li>"
        elif not matched_hook_pairs: html += "<li style='color: #c0392b;'>❌ Не найдено идентичных наборов лейблов между Web Push и Web Hook.</li>"
        
        for p, h, color, is_duplicate in matched_hook_pairs:
            dot = f"<span style='display:inline-block; width:12px; height:12px; border-radius:50%; background:{color}; margin-right:4px; box-shadow: 0 0 2px rgba(0,0,0,0.3);'></span>"
            dup_tag = " <span style='color: #8e44ad; font-size: 12px; font-weight: bold;'>(Дубликат)</span>" if is_duplicate else ""
            html += f"<li style='margin-bottom: 4px; display: flex; align-items: center; gap: 4px;'>{dot} <span>✅ <strong>Совпадение лейблов{dup_tag}:</strong> [Web Hook] {h} 🤝 [Web Push] {p}</span></li>"
            
        if len(pushes) == 1 and len(unmatched_hooks) == 1:
            hook, push = unmatched_hooks[0], pushes[0]
            h_labels = get_labels_from_text(f"{hook.get('title_url', '')} {hook.get('body', '')}")
            p_labels = get_labels_from_text(f"{push.get('title_url', '')} {push.get('body', '')} {push.get('link', '')} {push.get('button1', '')} {push.get('image_url', '')} {push.get('icon_url', '')}")
            missing = h_labels - p_labels
            diff_str = f"<b>Отсутствуют в Web Push:</b> {', '.join(missing)}" if missing else "Лейблы идентичны, ошибка структуры"
            html += f"<li style='margin-bottom: 4px; color: #e67e22;'>⚠️ <strong>Дельта лейблов:</strong> [Web Hook] {make_link(hook)} vs [Web Push] {make_link(push)}<div style='margin-top:6px; padding:10px; background:#fdebd0; border-left:3px solid #e67e22; border-radius:4px; color:#d35400; font-size:12px;'>{diff_str}</div></li>"
        else:
            for hook in unmatched_hooks: html += f"<li style='margin-bottom: 4px; color: #e67e22;'>⚠️ <strong>Нет пары:</strong> [Web Hook] {make_link(hook)} имеет уникальные наборы лейблов.</li>"

        html += """
            </ul></div>
            <div style="margin-top: auto; padding-top: 15px; border-top: 1px dashed #cbd5e1; text-align: right;">
                <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: bold; color: #64748b; background: #ffffff; padding: 6px 12px; border-radius: 6px; border: 1px solid #e2e8f0; transition: 0.2s;" onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background='#ffffff'">
                    <input type="checkbox" class="general-cb" style="transform: scale(1.2);"> Проверено
                </label>
            </div>
        </div>
        """
        return html, pair_colors
    
    def get_qa_personas(self, use_dynamic=False):
        """
        Fetches test profiles from the protected QA_PERSONAS_JSON environment variable.
        Ensures no sensitive data is hardcoded in the repository.
        """
        import os
        import json
        
        personas_env = os.getenv("QA_PERSONAS_JSON")
        
        if not personas_env:
            print("WARNING: QA_PERSONAS_JSON environment variable not found! Using empty list.")
            return {}

        try:
            all_personas = json.loads(personas_env)
            
            # 1. If we are on env 7
            if "boapi7" in self.boapi_host or "drive-7" in self.drive_host:
                return all_personas.get("boapi7", {})
                
            # 2. If we are on env 5
            elif "boapi5" in self.boapi_host or "drive-5" in self.drive_host:
                return all_personas.get("boapi5", {})
                
            # 3. Else (we are on env 2 / default drive)
            else:
                return all_personas.get("boapi", {})
                
        except json.JSONDecodeError:
            print("ERROR: Failed to parse QA_PERSONAS_JSON. Ensure it is valid JSON.")
            return {}
            
    def generate_html_report(self, data):
        import time
        expected_data = data.get('expected_data')
        t_start_html = time.time()
        print("\n[DEBUG-HTML] 🟡 СТАРТ СБОРКИ HTML ОТЧЕТА...")
        
        def esc(t): return str(t).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')
        brand_id = data.get('brand_id', '')

        def render_gen_seg(gen_data, seg_data, title):
            if not gen_data or not seg_data: return ""
            
            general_rows = ""
            for k, v in list(gen_data.items()):
                val_html = f"<a href='{v}' target='_blank' style='color: #2980b9; text-decoration: none; border-bottom: 1px dashed;'>{esc(v)}</a>" if k == "Target URL" else esc(v)
                general_rows += f"<tr class='dim-target'><td><b>{esc(k)}</b></td><td>{val_html}</td></tr>"

            state_html = "".join([f"<li style='margin-bottom: 4px;'>{esc(c)}</li>" for c in seg_data['state_conditions']]) or "<i>Нет условий</i>"
            modal_html = "".join([f"<li style='margin-bottom: 4px;'>{esc(c)}</li>" for c in seg_data['modal_conditions']]) or "<i>Нет исключений</i>"

            return f"""
            <div style="flex:1; min-width: 320px; background: #fff; border: 1px solid #D1D5DB; border-radius: 8px; padding: 16px; box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                <h3 style="color: #2c3e50; margin-top: 0; margin-bottom: 12px; border-bottom: 2px solid #3498db; padding-bottom: 8px; font-size: 16px;">{esc(title)}</h3>
                <div class="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700 mb-4">
                    <table class="data-table min-w-full text-sm">{general_rows}</table>
                </div>
                <div class="dim-target" style="border-top: 1px dashed #ddd; padding-top: 12px;">
                    <div style="margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
                         
                        <strong style="color: #2c3e50; font-size: 14px;">Segment:</strong>
                        <a href="{seg_data['url']}" target="_blank" style="font-weight:bold; color:#2980b9; text-decoration:none; border-bottom: 1px dashed;">{esc(seg_data['name'])}</a>
                    </div>
                    <details style="margin-bottom: 8px; background:#fdfefe; border: 1px solid #d4efdf; padding:6px 10px; border-radius:4px;"><summary style="cursor: pointer; font-weight: bold; color: #27ae60; font-size: 12px;">✅ Настройки сегмента ({len(seg_data['state_conditions'])})</summary><ul style="margin: 8px 0 0; padding-left: 20px; font-size: 12px; font-family: monospace;">{state_html}</ul></details>
                    <details style="background:#fdfefe; border: 1px solid #f5b041; padding:6px 10px; border-radius:4px;"><summary style="cursor: pointer; font-weight: bold; color: #d35400; font-size: 12px;">🚫 Исключения ({len(seg_data['modal_conditions'])})</summary><ul style="margin: 8px 0 0; padding-left: 20px; font-size: 12px; font-family: monospace;">{modal_html}</ul></details>
                </div>
            </div>
            """

        general_and_segment_html = f"""
        <div style="display: flex; flex-wrap: wrap; gap: 20px;">
            {render_gen_seg(data.get('general_main'), data.get('segment_main'), '📅 Основная кампания')}
            {render_gen_seg(data.get('general_pop'), data.get('segment_pop'), '🎯 Поп-ап')}
        </div>
        """

        ctx_status_main = data.get('context_status_main')
        ctx_status_pop = data.get('context_status_pop')
        
        def render_ctx_badge(status, camp_label):
            if not status: return ""
            if '✅' in str(status):
                badge = f"<span style='background:#dcfce7; color:#166534; padding:4px 10px; border-radius:12px; font-size:13px; font-weight:bold; border:1px solid #86efac; word-break: break-word;'>{esc(status)}</span>"
            else:
                badge = f"<span style='background:#fef2f2; color:#991b1b; padding:4px 10px; border-radius:12px; font-size:13px; font-weight:bold; border:1px solid #fca5a5; word-break: break-word;'>{esc(status)}</span>"
            return f"<div style='display:flex; align-items:center; gap:8px; margin-bottom:4px;'><span style='color:#64748b; font-size:12px;'>{camp_label}:</span> {badge}</div>"

        main_badge_html = render_ctx_badge(ctx_status_main, "Scheduled")
        pop_badge_html = render_ctx_badge(ctx_status_pop, "Journey")

        # Если вообще нет ссылок, выводим заглушку
        if not main_badge_html and not pop_badge_html:
             main_badge_html = render_ctx_badge("N/A", "Context")

        context_html = f"""<div class="dim-target" style="margin-top: 15px; background: #f8f9fa; border-left: 4px solid #3498db; padding: 12px; border-radius: 4px; display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
            <div style="display: flex; flex-direction: column; gap: 4px;">
                <strong>🔗 campaign tags:</strong>
                {main_badge_html}
                {pop_badge_html}
            </div>
            <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: bold; color: #64748b; background: #ffffff; padding: 4px 10px; border-radius: 6px; border: 1px solid #e2e8f0; transition: 0.2s;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#ffffff'">
                <input type="checkbox" class="general-cb" style="transform: scale(1.2);"> Проверено
            </label>
        </div>"""

        # Достаем список карт и склеиваем их в один большой HTML-блок
        flow_html_list = data.get('interactive_flow', [])
        flow_html = "".join(flow_html_list) if isinstance(flow_html_list, list) else data.get('interactive_flow', '')
        audit_period = data.get('audit_period', 'N/A')

        mc_html_parts = []
        grouped_mcs = {}
        
        for mc in data.get('mc_registry', []) or []:
            node_name = mc.get('name', 'Unknown')
            branches_for_sig = []
            display_branches = []
            
            for b in mc.get('branches', []):
                b_name = str(b.get('name', 'Unknown')).strip()
                norm_b_name = " ".join(sorted(b_name.lower().split()))
                b_cond_raw = str(b.get('condition', '')).strip()
                
                if not b_cond_raw or b_cond_raw == "No conditions" or b_cond_raw == "()":
                    sorted_cond = ""
                else:
                    rules = [r.strip() for r in re.split(r'\nAND\s+|\s+AND\s+', b_cond_raw) if r.strip()]
                    
                    def normalize_rule_string_local(rule_str):
                        m = re.search(r'\(([^()]+)\)\s*$', rule_str)
                        if m:
                            inner = m.group(1)
                            if not inner.strip(): return rule_str
                            vals = []
                            for v in inner.split(','):
                                v = v.strip()
                                if ' / ' in v:
                                    v = v.split(' / ')[-1].strip()
                                vals.append(v)
                            vals.sort(key=lambda x: x.lower())
                            return rule_str[:m.start(1)] + ", ".join(vals) + rule_str[m.end(1):]
                        return rule_str

                    cleaned_rules = [normalize_rule_string_local(r) for r in rules]
                    sorted_cond = " AND ".join(sorted(cleaned_rules, key=lambda x: x.lower()))
                    
                branches_for_sig.append((norm_b_name, sorted_cond))
                display_branches.append((b_name, sorted_cond))
                
            branches_for_sig.sort()
            display_branches.sort(key=lambda x: " ".join(sorted(x[0].lower().split())))
                
            sig = (node_name, tuple(branches_for_sig))
            
            if sig not in grouped_mcs:
                grouped_mcs[sig] = {
                    "name": node_name,
                    "count": 0,
                    "display_branches": display_branches
                }
            grouped_mcs[sig]["count"] += 1

        def format_smartico_rule_local(rule_str):
            rule_str = rule_str.strip()
            if not rule_str: return ""
            m_op = re.match(r"^'([^']+)'\s+(.+?)\s+\((.*)\)$", rule_str)
            if m_op: return f"✔️ - {esc(m_op.group(1))} | <b>{esc(m_op.group(2))}</b> | <b>{esc(m_op.group(3))}</b>"
            m_op_num = re.match(r"^'([^']+)'\s+(.+?)\s+(\d+)$", rule_str)
            if m_op_num: return f"✔️ - {esc(m_op_num.group(1))} | <b>{esc(m_op_num.group(2))}</b> | <b>{esc(m_op_num.group(3))}</b>"
            m_not = re.match(r"^not\s+'([^']+)'$", rule_str, re.IGNORECASE)
            if m_not: return f"✔️ - {esc(m_not.group(1))} | <b>=</b> | <b>False</b>"
            m_true = re.match(r"^'([^']+)'$", rule_str)
            if m_true: return f"✔️ - {esc(m_true.group(1))} | <b>=</b> | <b>True</b>"
            return f"✔️ - {esc(rule_str)}"

        for sig, group in list(grouped_mcs.items()):
            count_label = f" <span style='background:#eff6ff; color:#1d4ed8; padding:2px 8px; border-radius:12px; font-size:12px; margin-left:6px;'>x{group['count']}</span>" if group['count'] > 1 else ""
            node_name_esc = esc(group['name'])
            
            branches_html = "<ul style='margin-top: 12px; padding-left: 0; font-size: 14px; line-height: 1.6; list-style-type: none;'>"
            
            for b_name, norm_cond in group['display_branches']:
                b_name_esc = esc(b_name)
                
                if not norm_cond:
                    rules_html = "<i style='color: #94a3b8;'>Нет заданных условий (All users)</i>"
                else:
                    rules = norm_cond.split(" AND ")
                    or_rules = []
                    std_rules = []
                    for r in rules:
                        r_clean = r.strip()
                        r_clean = re.sub(r'\s*\n\s*', ' ', r_clean)
                        if re.search(r'\bOR\b', r_clean) and r_clean.lstrip(" '\"").startswith("("):
                            r_clean = r_clean.strip("'\"")
                            or_rules.append(r_clean)
                        else:
                            std_rules.append(r_clean)
                            
                    rules_html_parts = []
                    if or_rules:
                        or_inner = "<br>".join([f"🔸 <span style='color:#b45309; font-family:monospace;'>{esc(r)}</span>" for r in or_rules])
                        rules_html_parts.append(f"<div style='background:#fef3c7; border:1px solid #fde68a; border-left:4px solid #f59e0b; padding:8px 12px; border-radius:4px; margin-bottom:10px; font-size:13px;'><b>⚠️ Сработает любое из условий (OR):</b><br>{or_inner}</div>")
                    if std_rules:
                        rules_html_parts.append("<br>".join([format_smartico_rule_local(r) for r in std_rules]))
                        
                    rules_html = "".join(rules_html_parts)
                
                branches_html += f"""
                <li style='margin-bottom: 12px;'>
                    <b style='color: #0f172a; font-size: 15px;'>{b_name_esc}</b>
                    <div style='margin-top: 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-left: 4px solid #3b82f6; padding: 10px; border-radius: 4px; font-family: monospace; font-size: 13px; color: #334155; word-wrap: break-word;'>
                        {rules_html}
                    </div>
                </li>
                """
                
            branches_html += "</ul>"

            card_html = f"""
            <div class='dim-target' style='background: #ffffff; border: 1px solid #cbd5e1; border-left: 5px solid #64748b; border-radius: 8px; padding: 18px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); transition: 0.3s;'>
                <h4 style="margin: 0 0 12px 0; color: #1e293b; font-size: 16px; font-weight: bold; display: flex; align-items: center; gap: 8px;">
                     🔀 Multi-Check: {node_name_esc}{count_label}
                </h4>
                {branches_html}
                <div style="margin-top: 15px; padding-top: 10px; border-top: 1px dashed #cbd5e1; text-align: right;">
                    <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: bold; color: #64748b; background: #f8fafc; padding: 6px 12px; border-radius: 6px; border: 1px solid #e2e8f0; transition: 0.2s;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f8fafc'">
                        <input type="checkbox" class="general-cb" style="transform: scale(1.2);"> Проверено
                    </label>
                </div>
            </div>
            """
            mc_html_parts.append(card_html)

        mc_html = "".join(mc_html_parts)
        
        # --- ГЕНЕРАЦИЯ БЛОКА ПРОВЕРОК ПРОФИЛЯ (Condition Checks) ---
        cond_html = ""
        for item in data.get('condition_registry', []) or []:
            c_raw = str(item.get('condition', ''))
            
            if not c_raw or c_raw == "No conditions" or c_raw.strip() == "()":
                parsed_cond = "<i style='color:#94a3b8;'>Нет заданных условий</i>"
            else:
                raw_rules = re.split(r'\nAND\s+|\s+AND\s+', c_raw)
                parsed_cond = "<br>".join([format_smartico_rule_local(r) for r in raw_rules])
                
            cond_html += f"""
            <div class='dim-target' style='background: #f8fafc; border: 1px solid #cbd5e1; border-left: 4px solid #64748b; border-radius: 8px; padding: 16px; margin-bottom: 12px; transition: 0.3s;'>
                <h4 style="margin: 0 0 10px 0; color: #334155; font-size: 16px; display: flex; align-items: center; gap: 8px;">
                    🕵️‍♂️ {esc(item['name'])}
                </h4>
                <div style="background: #ffffff; padding: 12px; border-radius: 6px; border: 1px solid #e2e8f0; border-left: 3px solid #94a3b8; font-family: monospace; font-size: 13px; color: #334155; word-wrap: break-word;">
                    {parsed_cond}
                </div>
                <div style="margin-top: 15px; padding-top: 10px; border-top: 1px dashed #cbd5e1; text-align: right;">
                    <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: bold; color: #64748b; background: #ffffff; padding: 6px 12px; border-radius: 6px; border: 1px solid #e2e8f0; transition: 0.2s;" onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background='#ffffff'">
                        <input type="checkbox" class="general-cb" style="transform: scale(1.2);"> Проверено
                    </label>
                </div>
            </div>
            """
        
        # --- ГЕНЕРАЦИЯ БЛОКА WAIT FOR EVENT ВЫКЛЮЧЕНА ---
        wait_html = ""
        wait_block_html = ""

        cond_block_html = f"""
        <div class="card">
            <h2 class="text-xl font-bold mb-5 flex items-center gap-2 border-b border-slate-100 dark:border-slate-700 pb-3"> 🕵️‍♂️ User Profile Checks</h2>
            <div class="searchable-content flex flex-col gap-2">{cond_html}</div>
            <div style="margin-top: 20px; padding-top: 15px; border-top: 2px solid #e2e8f0; text-align: right;">
                <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: bold; color: #1e293b; background: #f1f5f9; padding: 8px 16px; border-radius: 8px; border: 1px solid #cbd5e1; transition: 0.2s;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f1f5f9'">
                    <input type="checkbox" class="section-cb" style="transform: scale(1.3);"> Отметить всю секцию
                </label>
            </div>
        </div>
        """ if cond_html else ""
        
        settings_groups = {}
        for item in data.get('settings_registry', []) or []:
            n_type = item.get('type', 'Unknown')
            caps = esc(item.get('caps', 'N/A'))
            
            if n_type == "Pop-up":
                opt = "N/A"
                period_disp = "N/A"
                dt = esc(item.get('delivery_timeout', 'N/A'))
                is_pop = True
            else:
                opt = esc(item.get('optout', 'N/A')).replace("ID: None", "N/A")
                period_disp = esc(item.get('period_display', 'N/A')).replace("ID: None", "N/A")
                dt = "N/A"
                is_pop = False
                
            sig = f"{opt}|{caps}|{period_disp}|{dt}"
            
            if sig not in settings_groups:
                settings_groups[sig] = {
                    "nodes": [], 
                    "caps": caps, 
                    "optout": opt, 
                    "period_display": period_disp,
                    "delivery_timeout": dt,
                    "is_pop": is_pop
                }
                
            node_name = item.get('name', 'Unknown')
            if node_name not in settings_groups[sig]["nodes"]:
                settings_groups[sig]["nodes"].append(node_name)

        settings_html = ""
        for sig, group in list(settings_groups.items()):
            nodes_names = " / ".join([esc(n) for n in group.get("nodes", [])])
            
            li_parts = []
            if group['period_display'] != "N/A":
                li_parts.append(f"<li><b>⏱️ Allowed Hours:</b> <span style='color: #444;'>{group['period_display']}</span></li>")
            if group['delivery_timeout'] != "N/A":
                li_parts.append(f"<li><b>⏱️ Delivery timeout:</b> <span style='color: #444;'>{group['delivery_timeout']}</span></li>")
            if group['optout'] != "N/A":
                li_parts.append(f"<li><b>🚫 Opt-out Status:</b> <span style='color: #444;'>{group['optout']}</span></li>")
            if group['caps'] != "N/A":
                li_parts.append(f"<li><b>🛑 Caps Status:</b> <span style='color: #444;'>{group['caps']}</span></li>")

            border_color = "#f39c12" if group.get("is_pop") else "#34495e"

            settings_html += f"""
            <div class="card dim-target" style="border-left-color: {border_color}; transition: 0.3s;">
                <h3 style="margin-top:0; color: #2c3e50; display: flex; align-items: center; gap: 8px;">
                    {nodes_names}
                </h3>
                <ul style="list-style-type: none; padding-left: 0; line-height: 1.6;">
                    {"".join(li_parts)}
                </ul>
                <div style="margin-top: 15px; padding-top: 10px; border-top: 1px dashed #cbd5e1; text-align: right;">
                    <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: bold; color: #64748b; background: #f8fafc; padding: 6px 12px; border-radius: 6px; border: 1px solid #e2e8f0; transition: 0.2s;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f8fafc'">
                        <input type="checkbox" class="general-cb" style="transform: scale(1.2);"> Проверено
                    </label>
                </div>
            </div>
            """

        settings_block_html = f"""
        <div class="card">
            <h2 class="text-xl font-bold mb-5 flex items-center gap-2 border-b border-slate-100 dark:border-slate-700 pb-3"> ⚙️ Node Settings</h2>
            <div class="searchable-content flex flex-col gap-4">{settings_html}</div>
            <div style="margin-top: 20px; padding-top: 15px; border-top: 2px solid #e2e8f0; text-align: right;">
                <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: bold; color: #1e293b; background: #f1f5f9; padding: 8px 16px; border-radius: 8px; border: 1px solid #cbd5e1; transition: 0.2s;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f1f5f9'">
                    <input type="checkbox" class="section-cb" style="transform: scale(1.3);"> Отметить всю секцию
                </label>
            </div>
        </div>
        """ if settings_html else ""

        print(f"[DEBUG-HTML] ⏳ Базовые блоки (Map, Logic, Cond) собраны за: {time.time() - t_start_html:.2f} сек")
        t_cross = time.time()

        # 🚨 ОБРАЩЕНИЕ ЧЕРЕЗ SELF
        cross_channel_html, pair_colors = self.generate_push_pwa_comparison(data['deep_analysis'])
        
        print(f"[DEBUG-HTML] ⏳ Кросс-канальный анализ (Push vs PWA) занял: {time.time() - t_cross:.2f} сек")
        t_deep = time.time()

        # 🚨 ФИКС СКОРОСТИ 5: Сквозной кэш для ВСЕХ нод. Снижает кол-во рендеров со 100 000 до 50!
        global_visited_macros = set()

        # 🚨 Изменен порядок вывода: Pop-up теперь в самом конце
        type_order = ["Email", "SMS", "Push", "Push PWA", "WebHook", "Pop-up"]
        type_color = {
            "Email": "#9b59b6", "SMS": "#e67e22", "Push": "#e74c3c", 
            "Push PWA": "#c0392b", "Pop-up": "#f39c12", "WebHook": "#27ae60"
        }

        content_groups = {}  
        for item in data['deep_analysis']:
            t = item['type']
            if t not in content_groups:
                content_groups[t] = []
            sig = (item.get('body','').strip(), item.get('title_url','').strip(), item.get('link','').strip(), item.get('subject','').strip())
            already = False
            for existing in content_groups[t]:
                ex_sig = (existing.get('body','').strip(), existing.get('title_url','').strip(), existing.get('link','').strip(), existing.get('subject','').strip())
                if ex_sig == sig:
                    existing.setdefault('node_names', [existing['name']]).append(item['name'])
                    already = True
                    break
            if not already:
                item_copy = dict(item)
                item_copy['node_names'] = [item['name']]
                content_groups[t].append(item_copy)
        
        nodes_html = ""
        for t in type_order:
            if t == "Push" and cross_channel_html:
                nodes_html += cross_channel_html
                cross_channel_html = ""  

            items = content_groups.get(t, [])
            if not items:
                continue
                
            css_color = type_color.get(t, "#34495e")
            nodes_html += f"<h3 style='margin-top:30px; color:{css_color}; border-bottom: 2px solid {css_color}; padding-bottom:6px;'>{t}</h3>"
            
            for item in items:
                t_item = time.time()
                names_display = " / ".join([esc(n) for n in item.get('node_names', [item['name']])])
                
                item_sig = (item.get('body','').strip(), item.get('title_url','').strip(), item.get('link','').strip(), item.get('subject','').strip())
                color = pair_colors.get(item_sig)
                
                dots_html = ""
                if color:
                    dots_html = f"<span style='display:inline-block; width:16px; height:16px; border-radius:50%; background:{color}; box-shadow: 0 2px 4px rgba(0,0,0,0.2);' title='Входит в связанную тройку (Cross-Channel)'></span>"
                
                card_inner = f"""
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
                    <h4 style="margin:0; color:{css_color}; display: flex; align-items: center; gap: 8px;">
                        {names_display}
                    </h4>
                    <div style="display:flex; align-items:center; gap:6px;">{dots_html}</div>
                </div>
                """
                
                errs = item.get('syntax_errors', [])
                comm_crit = []
                comm_warn = []
                if isinstance(errs, dict):
                    comm_crit = errs.get("critical", [])
                    comm_warn = errs.get("warning", [])
                elif isinstance(errs, list):
                    comm_crit = errs
                    
                errs_html_lines = []
                if comm_crit:
                    errs_html_lines.append(f"<div class='critical-error-flag' style='background: #fef2f2; border: 1px solid #fca5a5; color: #b91c1c; padding: 10px 14px; border-radius: 8px; font-size: 13px; font-weight: bold; margin-bottom: 12px;'>🚨 Критические синтаксические ошибки в тексте (без учета лейблов):<br>" + "<br>".join([f"• {esc(e)}" for e in comm_crit]) + "</div>")
                if comm_warn:
                    errs_html_lines.append(f"<div style='background: #fff3cd; border: 1px solid #f39c12; color: #856404; padding: 10px 14px; border-radius: 8px; font-size: 13px; font-weight: bold; margin-bottom: 12px;'>⚠️ Замечания в тексте (без учета лейблов):<br>" + "<br>".join([f"• {esc(e)}" for e in comm_warn]) + "</div>")
                
                card_inner += "".join(errs_html_lines)
                
                if t == "Email":
                    if item.get('resource_name'):
                        email_url = item.get('email_url', '#')
                        card_inner += f"<p style='margin:4px 0;'><b>Name:</b> <a href='{esc(email_url)}' target='_blank' style='color:#2980b9; text-decoration:none; border-bottom:1px dashed;'>{esc(item['resource_name'])}</a></p>"
                    if item.get('subject'): card_inner += f"<p style='margin:4px 0;'><b>Subject:</b> {esc(item['subject'])}</p>"
                    if item.get('status_name'): card_inner += f"<p style='margin:4px 0;'><b>Status:</b> {esc(item['status_name'])}</p>"
                    
                    b_val = item.get('body', '')
                    subj_val = item.get('subject', '')
                    card_inner += f"<details style='margin-top:10px;'><summary style='cursor:pointer; font-weight:bold; color:{css_color};'>📧 Show email body</summary><div class='pre-text' style='margin-top:8px;'>{esc(b_val if b_val else 'N/A')}</div></details>"
                    
                    # ⚡ ВНЕДРЯЕМ СВЕРКУ ВАРИАЦИЙ КОНТЕНТА
                    email_variations = item.get("variations", [])
                    if email_variations:
                        baseline_labels = [l for l in re.findall(r'\{\{label\.[^\s\}]+\}\}', b_val + " " + subj_val) if not self.is_ignored_label(l)]
                        baseline_counts = Counter(baseline_labels)
                        
                        var_html = "<div style='margin-top:15px; padding-top:10px; border-top:1px dashed #cbd5e1;'>"
                        var_html += f"<b style='color:#8e44ad; font-size:13px;'>🔄 Сверка макросов в вариациях ({len(email_variations)} шт.):</b>"
                        var_html += "<div style='display:flex; flex-direction:column; gap:6px; margin-top:8px;'>"
                        
                        for var in email_variations:
                            # Достаем условие, заменяем языковые коды на эмодзи флагов
                            var_cond = self.inject_flags(var.get("variation_condition_readable") or var.get("conditions_readable") or "Unknown")
                            var_text = str(var.get("body", "")) + " " + str(var.get("subject", ""))
                            
                            var_labels = [l for l in re.findall(r'\{\{label\.[^\s\}]+\}\}', var_text) if not self.is_ignored_label(l)]
                            var_counts = Counter(var_labels)
                            
                            if var_counts == baseline_counts:
                                var_html += f"<div style='background:#f8fafc; border:1px solid #cbd5e1; border-left:4px solid #10b981; padding:8px 12px; border-radius:4px; font-size:12px;'><b style='color:#334155;'>{esc(var_cond)}</b>: <span style='color:#15803d; margin-left:6px;'>✅ Макросы идентичны Default-версии</span></div>"
                            else:
                                missing = baseline_counts - var_counts
                                extra = var_counts - baseline_counts
                                errs = []
                                if missing: errs.append(f"<b>Отсутствуют:</b> {', '.join([f'{esc(k)}' for k in missing])}")
                                if extra: errs.append(f"<b>Лишние:</b> {', '.join([f'{esc(k)}' for k in extra])}")
                                
                                var_html += f"<div style='background:#fef2f2; border:1px solid #fca5a5; border-left:4px solid #ef4444; padding:8px 12px; border-radius:4px; font-size:12px;'><b style='color:#991b1b;'>{esc(var_cond)}</b>: <span style='color:#b91c1c; margin-left:6px;'>❌ Расхождение макросов!</span><div style='margin-top:4px; color:#7f1d1d;'>{'<br>'.join(errs)}</div></div>"
                                
                        var_html += "</div></div>"
                        card_inner += var_html
                    # ⚡ КОНЕЦ СВЕРКИ
                    
                    raw_lbls = re.findall(r'\{\{label\.[^\s\}]+\}\}', b_val + " " + subj_val)
                    f_lbls = []
                    for l in raw_lbls:
                        if l not in f_lbls: f_lbls.append(l)
                    
                    b_l, t_l, u_l, s_l, d_l, o_l = [], [], [], [], [], []
                    
                    for lbl in f_lbls:
                        low_lbl = lbl.lower()
                        # 🚨 ОБРАЩЕНИЕ ЧЕРЕЗ SELF
                        if self.is_ignored_label(lbl): continue
                        elif 'subitem' in low_lbl: s_l.append(lbl)
                        elif 'utm' in low_lbl: u_l.append(lbl)
                        elif 'img' in low_lbl or 'image' in low_lbl: b_l.append(lbl)
                        elif 'tnc' in low_lbl or 'terms' in low_lbl: t_l.append(lbl)
                        elif any(x in low_lbl for x in ['dynamic', 'subject', 'preheader', 'h1', 'header', 'content']): d_l.append(lbl)
                        else: o_l.append(lbl)
                        
                    labels_store = data.get("labels_data", {})
                    fmt = lambda lst: "<br>".join(lst) if lst else "Пусто"
                    
                    c_main = data.get('general_main', {}).get('Name', '')
                    c_pop = data.get('general_pop', {}).get('Name', '')
                    camp_name = (c_main or c_pop or 'Campaign').strip()

                    # 🚨 ОБРАЩЕНИЕ ЧЕРЕЗ SELF
                    def get_labels_ui(lst, check_utm=False): 
                        return "".join([self.render_audited_label_html(l, labels_store.get(l), brand_id, labels_store, visited=global_visited_macros, target_utm=(camp_name if check_utm else None), node_type=t, full_node_text=b_val, expected_data=expected_data) for l in lst]) if lst else "Пусто"
                    
                    def get_utm_ui(lst, target_name):
                        if not lst: return "Пусто"
                        html_out = ""
                        for i, l in enumerate(lst):
                            cb = "<span style='background:#DBEAFE; color:#1E3A8A; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:bold;'>🖼️ Банер</span>" if i == 0 else "<span style='background:#FEF3C7; color:#92400E; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:bold;'>👆 Кнопка</span>" if i == 1 else ""
                            ccls = "utm-banner" if i == 0 else "utm-button" if i == 1 else ""
                            # 🚨 ОБРАЩЕНИЕ ЧЕРЕЗ SELF
                            html_out += self.render_audited_label_html(l, labels_store.get(l), brand_id, labels_store, visited=global_visited_macros, target_utm=target_name, custom_badge=cb, custom_class=ccls, node_type=t, full_node_text=b_val, expected_data=expected_data)
                        return html_out

                    card_inner += f"<details style='margin-top:5px;'><summary style='cursor:pointer; font-weight:bold; color:#8e44ad;'>📁 All labels ({len(f_lbls)})</summary><div class='pre-text' style='font-size:12px;'>{fmt(f_lbls)}</div></details>"
                    
                    card_inner += f"<details style='margin-top:5px;'><summary style='cursor:pointer; font-weight:bold; color:#e67e22;'>🖼️ Banner ({len(b_l)})</summary><div style='margin-top:8px;'>{get_labels_ui(b_l)}</div></details>"
                    card_inner += f"<details style='margin-top:5px;'><summary style='cursor:pointer; font-weight:bold; color:#2980b9;'>📜 Terms and Conditions ({len(t_l)})</summary><div style='margin-top:8px;'>{get_labels_ui(t_l)}</div></details>"
                    card_inner += f"<details style='margin-top:5px;'><summary style='cursor:pointer; font-weight:bold; color:#2c3e50;'>📝 Dynamic content ({len(d_l)})</summary><div style='margin-top:8px;'>{get_labels_ui(d_l)}</div></details>"
                    card_inner += f"<details style='margin-top:5px;'><summary style='cursor:pointer; font-weight:bold; color:#16a085;'>🔗 UTM ({len(u_l)})</summary><div style='margin-top:8px;'>{get_utm_ui(u_l, camp_name)}</div></details>"
                    
                    if s_l: card_inner += f"<details style='margin-top:5px;'><summary style='cursor:pointer; font-weight:bold; color:#3498db;'>🧩 Subitem ({len(s_l)})</summary><div style='margin-top:8px;'>{get_labels_ui(s_l)}</div></details>"
                    if o_l: card_inner += f"<details style='margin-top:5px;'><summary style='cursor:pointer; font-weight:bold; color:#7f8c8d;'>📦 Unique labels ({len(o_l)})</summary><div style='margin-top:8px;'>{get_labels_ui(o_l)}</div></details>"
                
                    previews = item.get("previews", [])
                    if previews:
                        preview_html = "<div><div style='display:flex; flex-wrap:nowrap; gap:20px; overflow-x:auto; padding:5px 5px 15px 5px;'>"
                        for prev in previews:
                            # Добавляем красивые бейджи в зависимости от персоны
                            tier_badge = "<span style='background:#fef08a; color:#854d0e; padding:2px 8px; border-radius:12px; font-size:11px; margin-left:8px; font-weight:bold;'>👑 VIP</span>" if "VIP" in prev['desc'] else f"<span style='background:#e2e8f0; color:#334155; padding:2px 8px; border-radius:12px; font-size:11px; margin-left:8px; font-weight:bold;'>🏷️ {esc(prev['desc'])}</span>"
                            
                            preview_html += f"""
                            <div style='flex: 0 0 auto; text-align:center; border: 1px solid #D1D5DB; padding: 15px; border-radius: 8px; background: #FFFFFF; width: 414px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);'>
                                <div style='display:flex; justify-content:center; align-items:center; margin-bottom:12px;'>
                                    <strong style='color:#111827; font-size:15px;'>👤 User ID: {esc(prev['uid'])}</strong> {tier_badge}
                                </div>
                                <img src='data:image/jpeg;base64,{prev['b64']}' style='width: 100%; height: auto; border: 1px solid #E5E7EB; border-radius: 6px;' loading='lazy' alt='Preview'>
                            </div>
                            """
                        preview_html += "</div></div>"
                        card_inner += f"<details style='margin-top:15px;'><summary style='cursor:pointer; font-weight:bold; color:#0A58CA; font-size: 15px;'>📸 Симуляция на реальных профилях ({len(previews)})</summary>{preview_html}</details>"
                    
                elif t in ["Push", "Push PWA"]:
                    res_name = item.get('resource_name') or f'Unnamed {t} Resource'
                    push_url = item.get('email_url', '#')
                    card_inner += f"<p style='margin:4px 0;'><b>Name:</b> <a href='{esc(push_url)}' target='_blank' style='color:{css_color}; text-decoration:none; border-bottom:1px dashed;'>{esc(res_name)}</a></p>"
                    if item.get('status_name'): card_inner += f"<p style='margin:4px 0;'><b>Status:</b> {esc(item['status_name'])}</p>"
                    if item.get('title_url'): card_inner += f"<p style='margin:4px 0;'><b>Title:</b> {esc(item['title_url'])}</p>"
                    
                    body_val = item.get('body', 'N/A')
                    card_inner += f"<p style='margin:4px 0; margin-top:10px;'><b>Text:</b></p><div class='pre-text' style='margin-top:4px;'>{esc(body_val)}</div>"
                    
                    for label, key in [("Icon", "icon_url"), ("Attached image", "image_url")]:
                        if item.get(key): card_inner += f"<p style='margin:4px 0;'><b>{label}:</b> <span style='font-family: monospace; color: #34495e; background: #ecf0f1; padding: 2px 4px; border-radius: 3px;'>{esc(item[key])}</span></p>"
                    
                    if item.get('button1'): card_inner += f"<p style='margin:4px 0;'><b>Button:</b> {esc(item['button1'])}</p>"
                    if item.get('link'): card_inner += f"<p style='margin:4px 0;'><b>Deep Link:</b> {esc(item['link'])}</p>"

                    p_title = str(item.get('title_url', ''))
                    link_text = str(item.get('link', ''))
                    labels_store = data.get("labels_data", {})
                    
                    # 🚨 ФИКС: Упаковываем в JSON, чтобы симулятор макроса смог понять, где именно находится макрос
                    json_context = json.dumps({"title": p_title, "body": body_val})
                    
                    # 🚨 ОБРАЩЕНИЕ ЧЕРЕЗ SELF
                    def get_labels_ui(lst): return "".join([self.render_audited_label_html(l, labels_store.get(l), brand_id, labels_store, node_type=t, full_node_text=json_context, expected_data=expected_data) for l in lst]) if lst else "Пусто"

                    p_raw = set(re.findall(r'\{\{label\.[^\s\}]+\}\}', f"{p_title} {body_val} {link_text} {item.get('button1', '')} {item.get('image_url', '')} {item.get('icon_url', '')}"))
                    # 🚨 ОБРАЩЕНИЕ ЧЕРЕЗ SELF
                    p_lbls = sorted([l for l in p_raw if not self.is_ignored_label(l)])
                    if p_lbls: card_inner += f"<details style='margin-top:10px;'><summary style='cursor:pointer; font-weight:bold; color:#d35400;'>📁 Labels ({len(p_lbls)})</summary><div style='margin-top:8px;'>{get_labels_ui(p_lbls)}</div></details>"
                
                elif t == "Pop-up":
                    res_name = item.get('resource_name') or 'Unnamed Pop-up Resource'
                    inapp_url = item.get('email_url', '#')
                    card_inner += f"<p style='margin:4px 0;'><b>Name:</b> <a href='{esc(inapp_url)}' target='_blank' style='color:{css_color}; text-decoration:none; border-bottom:1px dashed;'>{esc(res_name)}</a></p>"
                    if item.get('status_name'): card_inner += f"<p style='margin:4px 0;'><b>Status:</b> {esc(item['status_name'])}</p>"
                    if item.get('title_url'): card_inner += f"<p style='margin:4px 0;'><b>Title:</b> {esc(item['title_url'])}</p>"
                    
                    body_val = item.get('body', 'N/A')
                    card_inner += f"<p style='margin:4px 0; margin-top:10px;'><b>Text (sub_title):</b></p><div class='pre-text' style='margin-top:4px;'>{esc(body_val)}</div>"
                    
                    if item.get('image_url'): card_inner += f"<p style='margin:4px 0;'><b>Image:</b> <span style='font-family: monospace; color: #34495e; background: #ecf0f1; padding: 2px 4px; border-radius: 3px;'>{esc(item['image_url'])}</span></p>"
                    
                    if item.get('button1') or item.get('link'):
                        card_inner += f"<div style='margin-top:10px; padding:10px; border:1px solid #f39c12; border-radius:4px; background:#fffaf0;'>"
                        card_inner += f"<strong style='color:#d35400;'>🔘 Button</strong>"
                        if item.get('button1'): card_inner += f"<p style='margin:4px 0 0 0;'><b>Text:</b> {esc(item['button1'])}</p>"
                        if item.get('link'): card_inner += f"<p style='margin:4px 0 0 0;'><b>URL:</b> {esc(item['link'])}</p>"
                        card_inner += "</div>"
                    
                    p_title = str(item.get('title_url', ''))
                    link_text = str(item.get('link', ''))
                    labels_store = data.get("labels_data", {})
                    
                    # 🚨 ФИКС: Упаковываем в JSON, чтобы симулятор макроса смог понять, где именно находится макрос
                    json_context = json.dumps({"title": p_title, "body": body_val})
                    
                    # 🚨 ОБРАЩЕНИЕ ЧЕРЕЗ SELF
                    def get_labels_ui(lst): return "".join([self.render_audited_label_html(l, labels_store.get(l), brand_id, labels_store, node_type=t, full_node_text=json_context, expected_data=expected_data) for l in lst]) if lst else "Пусто"

                    p_raw = set(re.findall(r'\{\{label\.[^\s\}]+\}\}', f"{p_title} {body_val} {link_text} {item.get('button1', '')} {item.get('image_url', '')}"))
                    # 🚨 ОБРАЩЕНИЕ ЧЕРЕЗ SELF
                    p_lbls = sorted([l for l in p_raw if not self.is_ignored_label(l)])
                    if p_lbls: card_inner += f"<details style='margin-top:10px;'><summary style='cursor:pointer; font-weight:bold; color:#d35400;'>📁 Labels ({len(p_lbls)})</summary><div style='margin-top:8px;'>{get_labels_ui(p_lbls)}</div></details>"
                
                elif t == "SMS":
                    if item.get('resource_name'):
                        sms_url = item.get('email_url', '#')
                        card_inner += f"<p style='margin:4px 0;'><b>Name:</b> <a href='{esc(sms_url)}' target='_blank' style='color:#f39c12; text-decoration:none; border-bottom:1px dashed;'>{esc(item['resource_name'])}</a></p>"
                    if item.get('status_name'): card_inner += f"<p style='margin:4px 0;'><b>Status:</b> {esc(item['status_name'])}</p>"
                    
                    b_val = item.get('body', '')
                    card_inner += f"<p style='margin:4px 0; margin-top:10px;'><b>Message:</b></p><div class='pre-text' style='margin-top:4px;'>{esc(b_val if b_val else 'N/A')}</div>"
                    
                    labels_store = data.get("labels_data", {})
                    
                    # ⚡ ФИКС: Вычисляем camp_name для проверки UTM в SMS
                    c_main = data.get('general_main', {}).get('Name', '')
                    c_pop = data.get('general_pop', {}).get('Name', '')
                    camp_name_sms = (c_main or c_pop or 'Campaign').strip()
                    
                    # 🚨 ОБРАЩЕНИЕ ЧЕРЕЗ SELF (Передаем target_utm ТОЛЬКО если в названии лейбла есть 'utm')
                    def get_labels_ui(lst): return "".join([self.render_audited_label_html(l, labels_store.get(l), brand_id, labels_store, visited=global_visited_macros, target_utm=(camp_name_sms if "utm" in l.lower() else None), node_type=t, full_node_text=b_val, expected_data=expected_data) for l in lst]) if lst else "Пусто"

                    s_raw = set(re.findall(r'\{\{label\.[^\s\}]+\}\}', b_val))
                    # 🚨 ОБРАЩЕНИЕ ЧЕРЕЗ SELF
                    s_lbls = sorted([l for l in s_raw if not self.is_ignored_label(l)])
                    if s_lbls: card_inner += f"<details style='margin-top:10px;'><summary style='cursor:pointer; font-weight:bold; color:#d35400;'>📁 Labels ({len(s_lbls)})</summary><div style='margin-top:8px;'>{get_labels_ui(s_lbls)}</div></details>"        

                elif t == "WebHook":
                    if item.get('title_url'): card_inner += f"<p style='margin:4px 0;'><b>URL:</b> {esc(item['title_url'])}</p>"
                    
                    webhook_body = item.get('body', '')
                    
                    if ' ' in webhook_body:
                        space_badge = "<span style='background:#fadbd8; color:#900c3f; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:bold;'>❌ Есть пробелы</span>"
                    else:
                        space_badge = "<span style='background:#d4edda; color:#155724; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:bold;'>✅ Нет пробелов</span>"
                    
                    card_inner += f"<p style='margin:10px 0 4px 0; display:flex; align-items:center; gap:8px;'><b>Data:</b> {space_badge}</p>"
                    card_inner += f"<div class='pre-text' style='margin-top:4px;'>{esc(webhook_body if webhook_body else 'N/A')}</div>"
                    
                    labels_store = data.get("labels_data", {})
                    # 🚨 ОБРАЩЕНИЕ ЧЕРЕЗ SELF
                    def get_labels_ui(lst): return "".join([self.render_audited_label_html(l, labels_store.get(l), brand_id, labels_store, visited=global_visited_macros, node_type=t, full_node_text=f"{item.get('title_url','')} {webhook_body}", expected_data=expected_data) for l in lst]) if lst else "Пусто"

                    w_raw = set(re.findall(r'\{\{label\.[^\s\}]+\}\}', f"{item.get('title_url','')} {webhook_body}"))
                    # 🚨 ОБРАЩЕНИЕ ЧЕРЕЗ SELF
                    w_lbls = sorted([l for l in w_raw if not self.is_ignored_label(l)])
                    if w_lbls: card_inner += f"<details style='margin-top:10px;'><summary style='cursor:pointer; font-weight:bold; color:#27ae60;'>📁 Labels ({len(w_lbls)})</summary><div style='margin-top:8px;'>{get_labels_ui(w_lbls)}</div></details>"
                    
                else:
                    card_inner += f"<div class='pre-text' style='margin-top:8px;'>{esc(item.get('body','N/A'))}</div>"
                
                # ⚡ УНИВЕРСАЛЬНАЯ СВЕРКА ВАРИАЦИЙ (АВТОНОМНЫЙ ЖИВОЙ ПОДЗАПРОС ИЗ API)
                res_id = item.get('resource_id') or item.get('id')
                if not res_id and item.get('email_url'):
                    # Выкусываем ID ресурса из ссылки вида https://drive.smartico.ai/2828#/templated_mail/208555
                    m_id = re.search(r'/(\d+)/?$', str(item['email_url']))
                    if not m_id:
                        m_id = re.search(r'/(\d+)', str(item['email_url']))
                    if m_id:
                        res_id = int(m_id.group(1))

                endpoint_map = {
                    "Email": "templated_mail_variation",
                    "SMS": "resource_sms_variation",
                    "Push": "resource_push_variation",
                    "Push PWA": "resource_push_variation",
                    "WebHook": "resource_push_variation",
                    "Pop-up": "resource_inapp_variation"
                }
                endpoint = endpoint_map.get(t)
                
                variations = []
                actual_ui_route = endpoint
                if res_id and endpoint:
                    try:
                        v_url = f"https://{self.boapi_host}/api/{endpoint}"
                        # ⚡ ФИКС: Убрали жесткий фильтр "status", чтобы скачивать и активные вариации!
                        v_params = {
                            "filter": json.dumps({"resource_id": int(res_id)}),
                            "range": "[0,499]",
                            "sort": '["variation_priority","DESC"]',
                            "lbl": self.brand_id
                        }
                        v_res = requests.get(v_url, params=v_params, headers=self.headers, timeout=5)
                        if v_res.ok:
                            v_data = v_res.json()
                            variations = v_data.get("result", v_data) if isinstance(v_data, dict) else v_data
                            if not isinstance(variations, list): variations = []
                        
                        if t == "Pop-up" and not variations:
                            v_url_fb = f"https://{self.boapi_host}/api/templated_popup_variation"
                            v_res_fb = requests.get(v_url_fb, params=v_params, headers=self.headers, timeout=5)
                            if v_res_fb.ok:
                                v_data_fb = v_res_fb.json()
                                variations = v_data_fb.get("result", v_data_fb) if isinstance(v_data_fb, dict) else v_data_fb
                                if not isinstance(variations, list): variations = []
                                actual_ui_route = "templated_popup_variation"
                    except Exception as e:
                        print(f"[DEBUG-VAR-LIVE-ERR] Ошибка загрузки вариаций для {t} #{res_id}: {e}")

                # ⚡ ФИКС: Отсекаем фейковые вариации (если создана всего 1 вариация для "All users")
                if len(variations) <= 1:
                    variations = []

                # ⚡ Смарт-функция для резолва макросов (с учетом языка вариации)
                labels_store = data.get("labels_data", {})
                def resolve_macro_smart(mac, target_lang="EN"):
                    if self.is_ignored_label(mac): return ""
                    clean = self.normalize_label_name(mac)
                    if clean not in labels_store or not isinstance(labels_store.get(clean), dict) or "default" not in labels_store.get(clean):
                        fetched = self.get_label_data_with_variations(clean)
                        if fetched: labels_store[clean] = fetched
                        else: return "5000"
                        
                    m_data = labels_store.get(clean)
                    if not m_data: return "5000"
                    
                    m_def = str(m_data.get("default", ""))
                    m_vars = m_data.get("variations", [])
                    
                    # Если внутри JS функция (ищем case 'EN': или 'EN':)
                    if "function" in m_def or "Java.type" in m_def:
                        dp = re.compile(r'(?:["\']([A-Z]{2}(?:-[A-Za-z]{2})?)["\']|([A-Z]{2}(?:-[A-Za-z]{2})?))\s*:\s*(["\'`])(.*?)(?<!\\)\3', re.IGNORECASE | re.DOTALL)
                        for m in dp.finditer(m_def):
                            lng = (m.group(1) or m.group(2)).upper()
                            if lng == target_lang.upper(): return re.sub(r'<[^>]+>', '', m.group(4))
                        # Фолбэк на EN
                        for m in dp.finditer(m_def):
                            lng = (m.group(1) or m.group(2)).upper()
                            if lng == "EN": return re.sub(r'<[^>]+>', '', m.group(4))
                    
                    # Проверяем вариации макроса
                    matched_val = None
                    for v in m_vars:
                        cond = str(v.get("conditions_readable", "")).upper()
                        if f"({target_lang.upper()})" in cond or f" {target_lang.upper()} " in cond or cond.endswith(target_lang.upper()) or f"_{target_lang.upper()}" in cond:
                            matched_val = str(v.get("tag_value", ""))
                            break
                            
                    if matched_val is None and m_def.strip() and not ("function" in m_def or "Java.type" in m_def): 
                        matched_val = m_def
                    if matched_val is None and m_vars: 
                        matched_val = str(m_vars[0].get("tag_value", ""))
                    
                    res_val = str(matched_val) if matched_val is not None else "5000"
                    return re.sub(r'<[^>]+>', '', res_val).strip() or "5000"

                # ⚡ ФУНКЦИЯ ДЛЯ СИМУЛЯЦИИ SMS
                def simulate_sms(sim_body, target_lang="EN"):
                    is_js = "function(" in sim_body.replace(" ", "") or "Java.type" in sim_body
                    if is_js:
                        text_preview = f"<div style='margin-top:6px; padding:6px 8px; background:rgba(0,0,0,0.04); border-radius:4px; font-family:monospace; font-size:11px; color:#475569; word-break:break-word; border:1px solid rgba(0,0,0,0.05); max-height:150px; overflow-y:auto;'>{esc(sim_body)}</div>"
                        return f"<div style='margin-top:6px; background:#f8fafc; border:1px solid #cbd5e1; padding:8px 12px; border-radius:4px; font-size:12px; color:#475569;'>⚙️ <b>JS Function:</b> Длина не симулируется{text_preview}</div>"
                    
                    max_depth = 3
                    while max_depth > 0:
                        found_macros = set(re.findall(r'\{\{[^\}]+\}\}', sim_body))
                        if not found_macros: break
                        for mac in found_macros:
                            sim_body = sim_body.replace(mac, resolve_macro_smart(mac, target_lang))
                        max_depth -= 1
                        
                    sim_body = sim_body.replace('&nbsp;', ' ').strip()
                    sim_body = re.sub(r'<[^>]+>', '', sim_body)
                    sim_len = len(sim_body)
                    
                    gsm7_chars = set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€")
                    non_gsm7 = set(c for c in sim_body if c not in gsm7_chars)
                    encoding = "UCS-2" if non_gsm7 else "GSM-7"
                    parts = (sim_len // 153) + (1 if sim_len % 153 else 0) if encoding == "GSM-7" else (sim_len // 67) + (1 if sim_len % 67 else 0)
                    if parts == 0: parts = 1
                    limit = 160 if encoding == "GSM-7" else 70
                    
                    text_preview = f"<div style='margin-top:6px; padding:6px 8px; background:rgba(0,0,0,0.04); border-radius:4px; font-family:monospace; font-size:11px; color:#475569; word-break:break-word; border:1px solid rgba(0,0,0,0.05);'>{esc(sim_body)}</div>"
                    
                    if parts > 1:
                        return f"<div style='margin-top:6px; background:#fef2f2; border:1px solid #fca5a5; padding:8px 12px; border-radius:4px; font-size:12px; color:#991b1b;'>📱 <b>SMS Симуляция:</b> ~{sim_len} симв. | {encoding} | <b>{parts} SMS</b> (макс. {limit} на 1 смс) 🚨 Двойная тарификация!{text_preview}</div>"
                    else:
                        return f"<div style='margin-top:6px; background:#f0fdf4; border:1px solid #86efac; padding:8px 12px; border-radius:4px; font-size:12px; color:#166534;'>📱 <b>SMS Симуляция:</b> ~{sim_len} симв. | {encoding} | <b>{parts} SMS</b>{text_preview}</div>"

                if variations:
                    baseline_all_text = " ".join([str(val) for val in item.values() if isinstance(val, (str, int, float))])
                    baseline_labels = [l for l in re.findall(r'\{\{label\.[^\s\}]+\}\}', baseline_all_text) if not self.is_ignored_label(l)]
                    baseline_counts = Counter(baseline_labels)
                    
                    var_html = f"<details style='margin-top:15px;'><summary style='cursor:pointer; font-weight:bold; color:#8e44ad;'>🔄 Сверка макросов в вариациях ({len(variations)} шт.)</summary>"
                    var_html += "<div style='display:flex; flex-direction:column; gap:6px; margin-top:8px;'>"
                    
                    for var in variations:
                        raw_cond = str(var.get("variation_condition_readable") or var.get("conditions_readable") or "Unknown")
                        var_cond = self.inject_flags(raw_cond)
                        
                        lang_match = re.search(r'\b([A-Z]{2})\b', raw_cond.upper())
                        target_lang = lang_match.group(1) if lang_match else "EN"
                        
                        var_id = var.get("id", "")
                        var_url = f"https://{self.drive_host}/{self.brand_id}#/{actual_ui_route}/{var_id}" if self.drive_host and self.brand_id and actual_ui_route else "#"
                        var_link_html = f"<a href='{var_url}' target='_blank' style='color:#3b82f6; text-decoration:none; border-bottom:1px dashed #93c5fd; transition:0.2s;' onmouseover=\"this.style.color='#2563eb'\" onmouseout=\"this.style.color='#3b82f6'\">{esc(var_cond)}</a> <span style='color:#94a3b8; font-size:10px; font-weight:normal;'>(ID: {var_id})</span>"
                        
                        var_all_text = " ".join([str(val) for val in var.values() if isinstance(val, (str, int, float))])
                        var_labels = [l for l in re.findall(r'\{\{label\.[^\s\}]+\}\}', var_all_text) if not self.is_ignored_label(l)]
                        var_counts = Counter(var_labels)
                        
                        node_sim_html = ""
                        # ⚡ Оставляем симуляцию ТОЛЬКО для SMS
                        if t == "SMS":
                            node_sim_html = simulate_sms(str(var.get('body', '')), target_lang)

                        if var_counts == baseline_counts:
                            var_html += f"<div style='background:#f8fafc; border:1px solid #cbd5e1; border-left:4px solid #10b981; padding:8px 12px; border-radius:4px; font-size:12px;'><b style='color:#334155;'>{var_link_html}</b>: <span style='color:#15803d; margin-left:6px;'>✅ Макросы идентичны</span>{node_sim_html}</div>"
                        else:
                            missing = baseline_counts - var_counts
                            extra = var_counts - baseline_counts
                            errs = []
                            if missing: errs.append(f"<b>Отсутствуют:</b> {', '.join([f'{esc(k)}' for k in missing])}")
                            if extra: errs.append(f"<b>Лишние:</b> {', '.join([f'{esc(k)}' for k in extra])}")
                            var_html += f"<div style='background:#fef2f2; border:1px solid #fca5a5; border-left:4px solid #ef4444; padding:8px 12px; border-radius:4px; font-size:12px;'><b style='color:#991b1b;'>{var_link_html}</b>: <span style='color:#b91c1c; margin-left:6px;'>❌ Расхождение макросов!</span><div style='margin-top:4px; color:#7f1d1d;'>{'<br>'.join(errs)}</div>{node_sim_html}</div>"
                            
                    var_html += "</div></details>"
                    card_inner += var_html
                else:
                    # ⚡ Если вариаций ноды нет, просто выводим заглушку.
                    # Старый сценарий сам разберет JS-макросы внутри текста и отрисует цветные таблетки по языкам!
                    card_inner += "<div style='margin-top:15px; padding:10px 14px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; font-size:13px; color:#64748b; font-weight:bold; display:flex; align-items:center; gap:8px;'>ℹ️ Вариации контента отсутствуют</div>"

                # --- ЛОГИКА ГЛОБАЛЬНОГО АЛЕРТА ---
                has_critical_error = "critical-error-flag" in card_inner or "🚨" in card_inner
                
                global_warning_html = ""
                # ВРЕМЕННО ОТКЛЮЧЕНО ПО ПРОСЬБЕ:
                # if has_critical_error:
                #     global_warning_html = f"<div style='background: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px 16px; border-radius: 8px; font-weight: bold; font-size: 14px; margin-bottom: 15px; display: flex; align-items: center; gap: 10px; box-shadow: 0 4px 6px -1px rgba(239, 68, 68, 0.2);'>🛑 ВНИМАНИЕ! В этой коммуникации (или её макросах) найдена КРИТИЧЕСКАЯ ошибка! Срочно проверьте детали ниже.</div>"
                
                card_inner += f"""
                <div style="margin-top: 15px; padding-top: 10px; border-top: 1px dashed #cbd5e1; text-align: right;">
                    <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: bold; color: #64748b; background: #ffffff; padding: 6px 12px; border-radius: 6px; border: 1px solid #e2e8f0; transition: 0.2s;" onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background='#ffffff'">
                        <input type="checkbox" class="general-cb" style="transform: scale(1.2);"> Проверено
                    </label>
                </div>
                """
                nodes_html += f"<div class='card dim-target' style='border-left-color:{css_color};'>{global_warning_html}{card_inner}</div>"
                
                t_item_end = time.time()
                if (t_item_end - t_item) > 0.5:
                    print(f"[DEBUG-HTML] 🐢 ДОЛГАЯ НОДА: '{names_display}' -> {t_item_end - t_item:.2f} сек")
                else:
                    print(f"[DEBUG-HTML] ⚡ Отрисована нода '{names_display[:30]}...' -> {t_item_end - t_item:.2f} сек")

        camp_main = data.get('general_main', {}).get('Name')
        camp_pop = data.get('general_pop', {}).get('Name')
        campaign_name_title = esc(camp_main or camp_pop or 'Campaign Audit')
        
        flows = data.get("flow_links", [])
        smart_labels = {"impression": "Показано", "delivered": "Доставлено", "Executed": "Отправлено", "Timeout": "Таймаут", "When happened": "Событие"}

        links_from = defaultdict(list)
        links_to = defaultdict(list)
        for l in flows:
            links_from[l['source']].append(l)
            links_to[l['target']].append(l)

        end_nodes = set(l['target'] for l in flows if l['target'] not in links_from)
        start_nodes = set(l['source'] for l in flows if l['source'] not in links_to)
        if not start_nodes and flows: start_nodes = {flows[0]['source']}

        lanes = []
        MAX_LANES_LIMIT = 50  # 🚨 Жесткий лимит на количество сценариев (защита от зависаний)
        limit_reached = [False] # Используем список для возможности изменения флага внутри вложенной функции

        def explore(node, current_lane, visited):
            # Если лимит уже достигнут, мгновенно прерываем рекурсию во всех ветках
            if len(lanes) >= MAX_LANES_LIMIT:
                limit_reached[0] = True
                return

            if node in visited:
                lanes.append(current_lane)
                return
            
            visited.add(node)
            outgoing = links_from.get(node, [])
            
            if not outgoing:
                lanes.append(current_lane)
                return
                
            is_terminal_split = all(out['target'] in end_nodes for out in outgoing)
            
            if len(outgoing) > 1 and is_terminal_split:
                bundle_step = {
                    "type": "Outcomes",
                    "outcomes": outgoing
                }
                current_lane.append(bundle_step)
                lanes.append(current_lane)
            elif len(outgoing) > 1:
                for out in outgoing:
                    if len(lanes) >= MAX_LANES_LIMIT: break # Дополнительная проверка перед ветвлением
                    new_lane = current_lane.copy()
                    new_lane.append({"type": "Link", "data": out})
                    explore(out['target'], new_lane, visited.copy())
            else:
                out = outgoing[0]
                current_lane.append({"type": "Link", "data": out})
                explore(out['target'], current_lane, visited.copy())

        for start in start_nodes:
            if len(lanes) >= MAX_LANES_LIMIT: break
            explore(start, [{"type": "Start", "name": start}], set())

        journey_html = ""
        
        # 🚨 Если сработал лимит, выводим предупреждение в интерфейс
        if limit_reached[0]:
            journey_html += f"""
            <div style="margin-bottom: 16px; padding: 12px 16px; background: #fffbeb; color: #b45309; border: 1px solid #fde68a; border-left: 4px solid #f59e0b; border-radius: 6px; font-size: 13px; font-weight: bold; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
                ⚠️ Кампания имеет слишком сложную структуру ветвлений. Чтобы избежать зависания отчета, показаны только первые {MAX_LANES_LIMIT} сценариев из возможных.
            </div>
            """

        for idx, lane in enumerate(lanes):
            path_label = f"Сценарий #{idx+1}"
            
            for step in lane:
                if step["type"] == "Link":
                    src = step["data"]["source"]
                    if len(links_from.get(src, [])) > 1:
                        lbl = step["data"]["label"]
                        path_label = f"Ветка: <b>{esc(lbl.replace('(MATCHING) ', ''))}</b>"
                        break

            path_steps_html = ""
            
            def get_node_html(name, link_data=None):
                clean_name = re.sub(r'<[^>]+>', '', name).strip()
                n_lower = clean_name.lower()
                
                step_class = "journey-node-other"
                if "convert" in n_lower: step_class = "journey-node-convert"
                elif "stop" in n_lower: step_class = "journey-node-stop"
                elif "wait" in n_lower: step_class = "journey-node-wait"
                elif link_data and link_data.get('target_url'): step_class = "journey-node-com"
                else: step_class = "journey-node-split"
                
                pwa_badge = ""
                url_wrap_start, url_wrap_end = "", ""
                
                if link_data:
                    if link_data.get('is_pwa'):
                        pwa_badge = "<span style='color:#e74c3c; background:#fef2f2; border:1px solid #f87171; border-radius:3px; padding:1px 3px; font-size:9px; margin-left:4px;'>PWA</span>"
                    if link_data.get('target_url'):
                        url_wrap_start = f"<a href='{link_data['target_url']}' target='_blank' style='text-decoration:none; color:inherit; display:flex; align-items:center; width:100%; justify-content:center;'>"
                        url_wrap_end = "</a>"
                
                return f'''
                <div class="journey-node-box {step_class}">
                    {url_wrap_start}
                    <div class="journey-node-name" title="{esc(clean_name)}">{esc(clean_name)}</div>{pwa_badge}
                    {url_wrap_end}
                </div>
                '''
                
            def get_arrow_html(label):
                smart_lbl = smart_labels.get(label, label.replace('(MATCHING) ', ''))
                return f'''
                <div class="journey-arrow">
                    <span style="font-size:10px; color:#64748b; margin-bottom:2px; white-space:nowrap;">{esc(smart_lbl)}</span>
                    <span style="color:#cbd5e1;">&rarr;</span>
                </div>
                '''

            for i, step in enumerate(lane):
                if step["type"] == "Start":
                    path_steps_html += get_node_html(step["name"])
                elif step["type"] == "Link":
                    link = step["data"]
                    path_steps_html += get_arrow_html(link["label"])
                    path_steps_html += get_node_html(link["target"], link)
                elif step["type"] == "Outcomes":
                    path_steps_html += get_arrow_html("Исходы")
                    
                    out_html = ""
                    for out in step["outcomes"]:
                        tgt = re.sub(r'<[^>]+>', '', out['target']).strip()
                        lbl = out['label']
                        smart_lbl = smart_labels.get(lbl, lbl)
                        
                        if "convert" in tgt.lower(): badge = f"<span style='color:#15803d; font-weight:bold;'>🏆 {esc(tgt)}</span>"
                        elif "stop" in tgt.lower(): badge = f"<span style='color:#b91c1c; font-weight:bold;'>🛑 {esc(tgt)}</span>"
                        else: badge = f"<b>{esc(tgt)}</b>"
                        
                        out_html += f"<div style='margin:4px 0; font-size:11px; display:flex; justify-content:space-between; align-items:center; gap:10px; border-bottom:1px solid #f1f5f9; padding-bottom:4px;'><i style='color:#64748b;'>{esc(smart_lbl)}</i> {badge}</div>"
                    
                    path_steps_html += f"<div class='journey-node-box journey-node-outcomes' style='flex-direction:column; align-items:stretch; text-align:left; min-width:180px;'>{out_html}</div>"

            journey_html += f"""
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin-bottom:16px; box-shadow:0 1px 2px rgba(0,0,0,0.05);">
                <h4 style="margin: 0 0 12px 0; color:#334155; font-size:14px; border-bottom:1px solid #e2e8f0; padding-bottom:6px;">🔀 {path_label}</h4>
                <div style="display:flex; align-items:center; overflow-x:auto; padding-bottom:8px;">
                    {path_steps_html}
                </div>
            </div>
            """

        links_block_html = f"""
        <div class="flex flex-col gap-8 mb-8">
                <div class="card !mb-0">
                    <h2 class="text-xl font-bold mb-5 flex items-center gap-2 border-b border-slate-100 dark:border-slate-700 pb-3">
                         📍 General & Segments
                    </h2>
                    {general_and_segment_html}
                    <div class="mt-4">{context_html}</div>
                </div>
        """ if flows else ""

        html_content = f"""
        <!DOCTYPE html>
        <html lang="en" class="light" style="scroll-behavior: smooth;">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Audit: {campaign_name_title}</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <script>
                tailwind.config = {{
                    darkMode: 'class',
                    theme: {{ extend: {{ colors: {{ primary: '#3b82f6', darkbg: '#0f172a', darkcard: '#1e293b' }} }} }}
                }}
            </script>
            <style>
                /* Глобальные настройки */
                body {{ background: #F8FAFC !important; color: #1E293B; font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 0; }}
                
                /* Карточки (Плоский дизайн) */
                .card, .dim-target {{ 
                    background: #FFFFFF !important; 
                    border: 1px solid #E2E8F0 !important; 
                    border-radius: 12px !important; 
                    padding: 20px !important; 
                    box-shadow: 0 2px 4px rgba(0,0,0,0.02) !important; 
                    margin-bottom: 20px !important;
                }}
                
                /* Таблицы */
                table {{ width: 100%; border-collapse: collapse; text-align: left !important; }}
                th, td {{ padding: 12px 16px !important; border-bottom: 1px solid #E2E8F0 !important; color: inherit !important; }}
                th {{ cursor: pointer; background: #F8FAFC !important; font-weight: 600 !important; color: #475569 !important; font-size: 13px; text-transform: uppercase; }}
                th:hover {{ background: #F1F5F9 !important; }}

                /* БАЗОВЫЕ СПОЙЛЕРЫ (Уровень 1) */
                details {{ background: #FFFFFF !important; border: 1px solid #E2E8F0 !important; border-radius: 8px !important; margin-top: 12px !important; margin-bottom: 12px !important; box-shadow: 0 1px 2px rgba(0,0,0,0.01) !important; }}
                summary {{ padding: 12px 16px !important; font-weight: 600 !important; cursor: pointer !important; background: #F8FAFC !important; color: #334155 !important; display: flex !important; align-items: center !important; gap: 10px !important; border-radius: 8px; transition: 0.2s; list-style: none; outline: none; }}
                details[open] summary {{ border-bottom-left-radius: 0; border-bottom-right-radius: 0; border-bottom: 1px solid #E2E8F0 !important; background: #F1F5F9 !important; color: #0F172A !important; }}
                summary:hover {{ background: #E2E8F0 !important; }}
                details > div {{ padding: 16px !important; background: #FFFFFF !important; border-radius: 0 0 8px 8px; }}

                /* 🚨 АНТИ-КАША: ПЛОСКИЕ ВЛОЖЕННЫЕ СПОЙЛЕРЫ (Уровень 2+) */
                details details {{ 
                    margin: 8px 0 8px 16px !important; 
                    border: none !important; 
                    border-left: 2px solid #CBD5E1 !important; 
                    border-radius: 0 !important; 
                    box-shadow: none !important; 
                }}
                details details > summary {{ 
                    background: transparent !important; 
                    padding: 6px 12px !important; 
                    font-size: 13px !important; 
                    color: #475569 !important; 
                }}
                details details[open] > summary {{ font-weight: 700 !important; color: #0F172A !important; border-bottom: none !important; }}
                details details > summary:hover {{ background: #F1F5F9 !important; border-radius: 4px; }}
                details details > div {{ 
                    background: transparent !important; 
                    padding: 8px 12px 8px 24px !important; 
                    border: none !important; 
                }}

                /* Текстовые блоки (Pre-text) */
                .pre-text {{ background: #F8FAFC !important; color: #334155 !important; padding: 12px 16px !important; border-radius: 6px !important; font-family: ui-monospace, monospace; white-space: pre-wrap; font-size: 13px; margin-top: 8px !important; border: 1px solid #E2E8F0 !important; box-shadow: inset 0 1px 2px rgba(0,0,0,0.01) !important; line-height: 1.5; }}
                
                /* Прочие UI элементы */
                ul {{ padding-left: 24px !important; margin-top: 8px !important; margin-bottom: 8px !important; }}
                li {{ margin-bottom: 6px !important; }}
                a {{ color: #2563EB !important; font-weight: 600 !important; text-decoration: none !important; border-bottom: 1px dashed rgba(37, 99, 235, 0.4) !important; transition: 0.2s; }}
                a:hover {{ border-bottom: 1px solid #2563EB !important; color: #1D4ED8 !important; }}
                
                .general-cb, .sync-cb, .section-cb {{ accent-color: #2563EB !important; cursor: pointer; }}
                .dimmed-done {{ opacity: 0.5 !important; filter: grayscale(80%) !important; transition: 0.3s; }}
                .dimmed-done:hover {{ opacity: 0.8 !important; filter: grayscale(40%) !important; }}
                
                /* Dark Mode (Оптимизированный) */
                .dark body {{ background: #0B1120 !important; color: #E2E8F0; }}
                .dark .card, .dark .dim-target {{ background: #1E293B !important; border-color: #334155 !important; box-shadow: none !important; }}
                .dark details {{ background: #0F172A !important; border-color: #334155 !important; }}
                .dark summary {{ background: #1E293B !important; color: #F1F5F9 !important; }}
                .dark details[open] summary {{ background: #020617 !important; border-color: #334155 !important; }}
                .dark details details {{ border-left-color: #475569 !important; }}
                .dark .pre-text {{ background: #020617 !important; color: #94A3B8 !important; border-color: #334155 !important; }}
                .dark th {{ background: #0F172A !important; color: #94A3B8 !important; border-color: #334155 !important; }}
                .dark td {{ border-color: #334155 !important; }}
                
                /* Journey Map Styles (Оставлены без изменений) */
                .journey-node-box {{min-width: 140px; max-width: 160px; padding: 10px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 12px; font-weight: bold; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.05); flex-shrink: 0; display:flex; align-items:center; justify-content:center; background:#fff; }}
                .journey-node-outcomes {{ max-width: 250px; background: #fdfefe; border-color: #94a3b8; border-style: dashed; }}
                .journey-node-start {{ background: #f1f5f9; color: #475569; border-style: dashed; }}
                .journey-node-split {{ background: #fffbeb; border-color: #fcd34d; color: #b45309; }}
                .journey-node-com {{ background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; cursor: pointer; transition: 0.2s; }}
                .journey-node-com:hover {{ background: #dbeafe; transform: translateY(-2px); box-shadow: 0 4px 6px rgba(0,0,0,0.1); }}
                .journey-node-wait {{ background: #f3e8ff; border-color: #e9d5ff; color: #7e22ce; }}
                .journey-node-convert {{background: #dcfce7; border-color: #86efac; color: #15803d; }}
                .journey-node-stop {{ background: #fee2e2; border-color: #fca5a5; color: #b91c1c; }}
                .journey-arrow {{ display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 60px; padding: 0 10px; flex-shrink: 0; }}
                .journey-node-name {{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 100%; }}

                /* Pill UI for labels (С жесткими !important для перекрытия глобальных стилей) */
                details.sim-pill {{ position: relative !important; display: inline-block !important; margin: 2px 2px 4px 0 !important; vertical-align: top !important; background: transparent !important; border: none !important; box-shadow: none !important; }}
                details.sim-pill[open] {{ display: block !important; margin: 6px 0 !important; background: #fff !important; border: 1px solid #cbd5e1 !important; border-radius: 6px !important; padding: 10px !important; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1) !important; width: 100% !important; box-sizing: border-box !important; animation: fadeIn 0.2s ease-out !important; z-index: 10 !important; }}
                details.sim-pill > summary {{ width: auto !important; position: relative !important; display: inline-flex !important; align-items: center !important; gap: 4px !important; padding: 2px 8px !important; border-radius: 12px !important; font-size: 11px !important; cursor: pointer !important; user-select: none !important; transition: 0.2s !important; outline: none !important; list-style: none !important; font-family: sans-serif !important; margin: 0 !important; border-bottom: none !important; }}
                details.sim-pill > summary::-webkit-details-marker {{ display: none !important; }}
                details.sim-pill[open] > summary {{ border-radius: 6px !important; margin-bottom: 8px !important; box-shadow: none !important; border-bottom: 1px solid #cbd5e1 !important; background: #f8fafc !important; color: #0f172a !important; }}
                details.sim-pill > div {{ padding: 0 !important; margin: 0 !important; background: transparent !important; border: none !important; }}
                .sim-pill-content {{ font-family: monospace !important; font-size: 12px !important; white-space: pre-wrap !important; word-break: break-all !important; color: #475569 !important; }}

                /* 🚨 ФИКС ТУЛТИПА ПРИ НАВЕДЕНИИ */
                .custom-tooltip {{ display: none; position: absolute !important; bottom: 100% !important; left: 50% !important; transform: translateX(-50%) !important; background: #1e293b !important; color: #fff !important; padding: 6px 10px !important; border-radius: 6px !important; font-size: 11px !important; white-space: pre-wrap !important; word-break: break-word !important; width: max-content !important; max-width: 350px !important; z-index: 1000 !important; margin-bottom: 6px !important; box-shadow: 0 4px 6px rgba(0,0,0,0.1) !important; pointer-events: none !important; text-align: left !important; font-family: monospace !important; font-weight: normal !important; line-height: 1.4 !important; }}
                .custom-tooltip::after {{ content: '' !important; position: absolute !important; top: 100% !important; left: 50% !important; margin-left: -5px !important; border-width: 5px !important; border-style: solid !important; border-color: #1e293b transparent transparent transparent !important; }}
                details.sim-pill:not([open]) > summary:hover .custom-tooltip {{ display: block !important; }}

                /* 🚨 ФИКС ЦВЕТОВ (Полная заливка, а не только текст) */
                details.pill-green > summary {{ background: #e6ffed !important; color: #147b36 !important; border: 1px solid #79f29c !important; }}
                details.pill-green > summary:hover {{ background: #dcfce7 !important; }}
                details.pill-gray > summary {{ background: #f8fafc !important; color: #475569 !important; border: 1px solid #cbd5e1 !important; }}
                details.pill-gray > summary:hover {{ background: #f1f5f9 !important; }}
                details.pill-yellow > summary {{ background: #fffbeb !important; color: #92400e !important; border: 1px solid #fde68a !important; }}
                details.pill-yellow > summary:hover {{ background: #fef3c7 !important; }}
                details.pill-red > summary {{ background: #fef2f2 !important; color: #991b1b !important; border: 1px solid #fca5a5 !important; }}
                details.pill-red > summary:hover {{ background: #fee2e2 !important; }}
                
                /* 🚨 ФИЛЬТР ТАБЛЕТОК (По умолчанию прячем успешные) */
                body:not(.show-all-pills) .brand-perfect {{ display: none !important; }}
                body:not(.show-all-pills) details.pill-green {{ display: none !important; }}
                body:not(.show-all-pills) details.pill-gray {{ display: none !important; }}
                
                @keyframes fadeIn {{ from {{ opacity: 0; transform: translateY(-2px); }} to {{ opacity: 1; transform: translateY(0); }} }}
            </style>
        </head>
        <body class="antialiased flex">
            <aside class="w-72 fixed h-screen top-0 left-0 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col z-50 shadow-sm">
                <div class="p-6 border-b border-slate-100 dark:border-slate-800">
                    <h1 class="text-2xl font-black text-slate-900 dark:text-white leading-tight">Smartico<br><span class="text-blue-600">Audit</span></h1>
                </div>
                <nav class="flex-1 overflow-y-auto p-4 space-y-1">
                    <div class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 ml-2">Навигация</div>
                    {'<a href="#sec-general" class="block px-3 py-2 rounded-lg text-sm font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">📍 General & Segments</a>' if links_block_html else ''}
                    {'<a href="#sec-map" class="block px-3 py-2 rounded-lg text-sm font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">📸 Flow Map</a>' if flow_html else ''}
                    {'<a href="#sec-logic" class="block px-3 py-2 rounded-lg text-sm font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">🔀 Multi-Check Logic</a>' if mc_html else ''}
                    {'<a href="#sec-profile" class="block px-3 py-2 rounded-lg text-sm font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">🕵️‍♂️ Profile Checks</a>' if cond_block_html else ''}
                    {'<a href="#sec-funnel" class="block px-3 py-2 rounded-lg text-sm font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">⏳ Wait For Events</a>' if wait_block_html else ''}
                    {'<a href="#sec-settings" class="block px-3 py-2 rounded-lg text-sm font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">⚙️ Node Settings</a>' if settings_block_html else ''}
                    <a href="#sec-content" class="block px-3 py-2 rounded-lg text-sm font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">🔬 Content Analysis</a>
                </nav>
                <div class="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-800 space-y-2">
                    <button id="copyErrorsBtn" class="w-full text-left px-3 py-2.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/50 rounded-lg text-sm font-bold transition-colors">📋 Copy Errors (TSV)</button>
                    <button id="exportCsv" class="w-full text-left px-3 py-2.5 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-200 dark:hover:bg-emerald-900/50 rounded-lg text-sm font-bold transition-colors">📥 Export CSV</button>
                    <button id="themeToggle" class="w-full text-left px-3 py-2.5 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 rounded-lg text-sm font-bold transition-colors">🌓 Toggle Theme</button>
                </div>
            </aside>

            <main class="ml-72 flex-1 p-8 lg:p-12 xl:pr-24 max-w-[1400px]">
                
                <header class="sticky top-0 bg-[#F8FAFC]/95 dark:bg-[#0f172a]/95 backdrop-blur-md pt-4 pb-4 mb-10 z-40 border-b border-slate-200 dark:border-slate-800 flex justify-between items-end">
                    <div>
                        <h2 class="text-3xl font-extrabold text-slate-900 dark:text-white truncate max-w-3xl" title="{campaign_name_title}">{campaign_name_title}</h2>
                        <div class="text-sm text-blue-600 dark:text-blue-400 font-bold mt-1">📅 Flow Map Period: {audit_period}</div>
                    </div>
                    <input type="text" id="globalSearch" placeholder="🔍 Быстрый поиск..." class="px-4 py-2 w-72 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm shadow-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all">
                </header>

                <div class="flex flex-col gap-12">
                    
                    {f'''<section id="sec-general" class="scroll-mt-32">
                        <h2 class="text-2xl font-bold mb-6 text-slate-800 dark:text-slate-100 border-b border-slate-200 dark:border-slate-700 pb-2">📍 General & Segments</h2>
                        {links_block_html.replace('<div class="card !mb-0">', '<div>').replace('<h2 class="text-xl font-bold mb-5 flex items-center gap-2 border-b border-slate-100 dark:border-slate-700 pb-3">📍 General & Segments</h2>', '')}
                    </section>''' if links_block_html else ''}

                    {f'''<section id="sec-map" class="scroll-mt-32">
                        <div class="card !mb-0 !p-0 overflow-hidden">
                            <div class="px-6 py-4 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 font-bold text-lg text-slate-800 dark:text-white flex justify-between items-center">
                                📸 Интерактивная карта
                            </div>
                            <div class="p-6">
                                {flow_html}
                            </div>
                        </div>
                    </section>''' if flow_html else ''}

                    {f'''<section id="sec-logic" class="scroll-mt-32">
                        <h2 class="text-2xl font-bold mb-6 text-slate-800 dark:text-slate-100 border-b border-slate-200 dark:border-slate-700 pb-2">🔀 Multi-Check Logic</h2>
                        <div class="searchable-content flex flex-col">{mc_html}</div>
                    </section>''' if mc_html else ''}
                    
                    {f'''<section id="sec-profile" class="scroll-mt-32">
                        {cond_block_html}
                    </section>''' if cond_block_html else ''}

                    {f'''<section id="sec-funnel" class="scroll-mt-32">
                        {wait_block_html}
                    </section>''' if wait_block_html else ''}

                    {f'''<section id="sec-settings" class="scroll-mt-32">
                        {settings_block_html}
                    </section>''' if settings_block_html else ''}
                    
                    <section id="sec-content" class="scroll-mt-32">
                        <div class="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-200 dark:border-slate-700 pb-2 mb-6 gap-4">
                            <h2 class="text-2xl font-bold m-0 text-slate-800 dark:text-slate-100">🔬 Content Analysis</h2>
                            <label class="cursor-pointer flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 px-4 py-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors shadow-sm select-none">
                                <input type="checkbox" id="toggleAllPills" class="accent-blue-600 w-4 h-4 cursor-pointer">
                                <span>Показать зеленые переводы</span>
                            </label>
                        </div>
                        <div class="searchable-content flex flex-col">{nodes_html}</div>
                    </section>
                </div>
            </main>
            
            <button id="back-to-top" class="fixed bottom-8 right-8 bg-blue-600 text-white w-12 h-12 rounded-full shadow-lg hidden hover:bg-blue-700 transition-all z-50 text-xl font-bold flex items-center justify-center">↑</button>

            <script>
                document.addEventListener('DOMContentLoaded', () => {{
                    // Theme Toggle
                    const html = document.documentElement;
                    const toggleTheme = (isDark) => {{
                        html.classList.toggle('dark', isDark);
                        localStorage.setItem('audit-theme', isDark ? 'dark' : 'light');
                    }};
                    document.getElementById('themeToggle').addEventListener('click', () => toggleTheme(!html.classList.contains('dark')));
                    if (localStorage.getItem('audit-theme') === 'dark' || (!localStorage.getItem('audit-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {{
                        toggleTheme(true);
                    }}

                    // Toggle All Pills
                    document.getElementById('toggleAllPills')?.addEventListener('change', (e) => {{
                        document.body.classList.toggle('show-all-pills', e.target.checked);
                    }});

                    // Global Search
                    document.getElementById('globalSearch').addEventListener('input', (e) => {{
                        const term = e.target.value.toLowerCase();
                        document.querySelectorAll('.dim-target').forEach(el => {{
                            el.style.display = el.innerText.toLowerCase().includes(term) ? '' : 'none';
                        }});
                    }});

                    // Section Master Checkboxes
                    document.addEventListener('change', e => {{
                        if (e.target.matches('.section-cb')) {{
                            const isChecked = e.target.checked;
                            const card = e.target.closest('section, .card');
                            if (card) {{
                                card.querySelectorAll('.general-cb, .sync-cb').forEach(cb => {{
                                    cb.checked = isChecked;
                                    const dimTarget = cb.closest('.dim-target');
                                    if (dimTarget) dimTarget.classList.toggle('dimmed-done', isChecked);
                                }});
                            }}
                        }}
                    }});

                    // Sync Checkboxes
                    document.addEventListener('change', e => {{
                        if (e.target.matches('.general-cb, .sync-cb')) {{
                            const isChecked = e.target.checked;
                            e.target.closest('.dim-target').classList.toggle('dimmed-done', isChecked);
                            
                            const lbl = e.target.getAttribute('data-label');
                            if (lbl) {{
                                document.querySelectorAll(`.sync-cb[data-label="${{lbl}}"]`).forEach(s => {{
                                    s.checked = isChecked;
                                    s.closest('.dim-target').classList.toggle('dimmed-done', isChecked);
                                }});
                            }}
                        }}
                    }});

                    // Sortable Tables
                    document.querySelectorAll('.data-table th').forEach((th, i) => {{
                        th.addEventListener('click', () => {{
                            const table = th.closest('table');
                            const tbody = table.querySelector('tbody') || table;
                            const rows = Array.from(tbody.querySelectorAll('tr:not(:first-child)')); 
                            const asc = th.classList.toggle('asc');
                            rows.sort((a, b) => {{
                                const valA = a.cells[i]?.innerText || '';
                                const valB = b.cells[i]?.innerText || '';
                                return asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
                            }}).forEach(row => tbody.appendChild(row));
                        }});
                    }});
                    
                    // Copy Errors
                    document.getElementById('copyErrorsBtn').addEventListener('click', () => {{
                        const errorBlocks = document.querySelectorAll('.copyable-error');
                        if (errorBlocks.length === 0) {{ alert('Ошибок не найдено!'); return; }}
                        let tsv = "Бренд\\tЯзык\\tДетали ошибки\\n";
                        errorBlocks.forEach(block => {{
                            const brand = block.getAttribute('data-brand') || 'Global';
                            const lang = block.getAttribute('data-lang') || '-';
                            const doc = new DOMParser().parseFromString(block.getAttribute('data-details') || '', "text/html");
                            tsv += `${{brand}}\\t${{lang}}\\t${{doc.documentElement.textContent}}\\n`;
                        }});
                        const textArea = document.createElement("textarea");
                        textArea.value = tsv; document.body.appendChild(textArea); textArea.select();
                        try {{ document.execCommand('copy'); alert("✅ Ошибки скопированы!"); }} 
                        catch (err) {{ alert("Ошибка копирования"); }}
                        document.body.removeChild(textArea);
                    }});

                    window.copyLocalErrors = function(btn, event, onlyCritical) {{
                        event.preventDefault();
                        const detailsNode = btn.closest('details');
                        let errorBlocks;
                        if (onlyCritical) {{
                            errorBlocks = detailsNode.querySelectorAll('.critical-error-flag');
                        }} else {{
                            errorBlocks = detailsNode.querySelectorAll('.copyable-error');
                        }}
                        if (errorBlocks.length === 0) return;
                        let tsv = "Лейбл\\tБренд\\tЯзык/Условие\\tДетали ошибки\\n";
                        errorBlocks.forEach(block => {{
                            const macro = block.getAttribute('data-macro') || '-';
                            const brand = block.getAttribute('data-brand') || 'Global';
                            const lang = block.getAttribute('data-lang') || '-';
                            const doc = new DOMParser().parseFromString(block.getAttribute('data-details') || '', "text/html");
                            tsv += `${{macro}}\\t${{brand}}\\t${{lang}}\\t${{doc.documentElement.textContent}}\\n`;
                        }});
                        const textArea = document.createElement("textarea");
                        textArea.value = tsv; document.body.appendChild(textArea); textArea.select();
                        const originalText = btn.innerHTML;
                        try {{ document.execCommand('copy'); btn.innerHTML = "✅ Copied!"; setTimeout(() => btn.innerHTML = originalText, 2000); }} 
                        catch (err) {{ alert("Ошибка"); }}
                        document.body.removeChild(textArea);
                    }};

                    // АВТО-ЗАКРЫТИЕ СПОЙЛЕРОВ
                    document.querySelectorAll('details').forEach(details => {{
                        const closeBtn = document.createElement('button');
                        closeBtn.innerHTML = '⬆️ Свернуть';
                        closeBtn.className = 'mt-3 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 rounded text-xs font-semibold w-full text-center transition-colors shadow-sm';
                        closeBtn.addEventListener('click', (e) => {{
                            e.preventDefault();
                            const y = details.getBoundingClientRect().top + window.scrollY - 100;
                            window.scrollTo({{top: y, behavior: 'smooth'}});
                            setTimeout(() => details.removeAttribute('open'), 150);
                        }});
                        const contentContainer = Array.from(details.children).find(child => child.tagName.toLowerCase() === 'div');
                        if (contentContainer) contentContainer.appendChild(closeBtn);
                        else details.appendChild(closeBtn);
                    }});
                    
                    // CSV Export
                    document.getElementById('exportCsv').addEventListener('click', () => {{
                        let csv = [];
                        document.querySelectorAll('.data-table tr').forEach(row => {{
                            let cols = [];
                            row.querySelectorAll('td, th').forEach(col => cols.push('"' + col.innerText.replace(/"/g, '""') + '"'));
                            csv.push(cols.join(','));
                        }});
                        const blob = new Blob([csv.join('\\n')], {{ type: 'text/csv' }});
                        const url = window.URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url; a.download = 'audit_export.csv'; a.click();
                    }});

                    // Scroll to top
                    const btt = document.getElementById('back-to-top');
                    window.addEventListener('scroll', () => btt.classList.toggle('hidden', window.scrollY < 300));
                    btt.addEventListener('click', () => window.scrollTo({{ top: 0, behavior: 'smooth' }}));
                }});
            </script>
        </body>
        </html>
        """
        
        print(f"[DEBUG-HTML] ⏳ Анализ всего контента (nodes_html) занял: {time.time() - t_deep:.2f} сек")
        print(f"[DEBUG-HTML] 🟢 ИТОГО СБОРКА HTML ОТЧЕТА ЗАНЯЛА: {time.time() - t_start_html:.2f} сек\n")
        
        return html_content