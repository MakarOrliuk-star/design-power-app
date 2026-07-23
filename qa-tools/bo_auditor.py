import os
import requests
import re
import json
import asyncio
from datetime import datetime
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv() # Загружаем переменные из .env

BO_ORIGIN_URL = os.getenv("BO_ORIGIN_URL", "")
BO_API_BASE_URL = os.getenv("BO_API_BASE_URL", "")
BO_BRAND_DOMAIN = os.getenv("BO_BRAND_DOMAIN", "")

# ==========================================
# ⚙️ Pydantic Схема для API
# ==========================================
class BackofficeAuditRequest(BaseModel):
    brand: str
    targets: list[str]  # ["banner", "promotion"]
    token: str
    target_geos: list[str] = []
    offer_text: str = ""  # Оставляем заглушку, чтобы не ломался API

# ==========================================
# ⚙️ НАСТРОЙКИ И КАРТЫ
# ==========================================
GEO_TO_LOCALES = {
    "BR": ["pt", "pt_BR"], "PT": ["pt"], "AU": ["en"], "CA": ["en", "fr", "fr_CA"],
    "NZ": ["en"], "IE": ["en"], "KR": ["ko"], "DK": ["da"], "FI": ["fi"],
    "DE": ["de"], "AT": ["de"], "CH": ["de_CH", "fr_CH", "de", "fr"], "PL": ["pl"],
    "CZ": ["cs"], "HU": ["hu"], "NO": ["no"], "RO": ["ro"], "SK": ["sk"],
    "SI": ["sl"], "HR": ["hr"], "MK": ["mk_MK"], "RS": ["sr"], "GR": ["el"],
    "ES": ["es"], "IT": ["it"], "NL": ["nl"], "GB": ["en", "en_GB"], "FR": ["fr"],
    "ALL": ["en"] # Для GLOBAL обязательно наличие английского
}

NUM_TO_WORD = {"1": "first", "2": "second", "3": "third", "4": "fourth", "5": "fifth"}

# ==========================================
# 🚀 ГЛАВНЫЙ ГЕНЕРАТОР ПОТОКА (STREAM)
# ==========================================
async def run_backoffice_stream(payload: BackofficeAuditRequest):
    text_report_lines = []

    def yield_log(msg: str):
        # Очистка для текстового файла (чтобы можно было скачать лог)
        clean_text = re.sub(r'<br\s*/?>', '\n', msg, flags=re.IGNORECASE)
        clean_text = re.sub(r'<[^>]+>', '', clean_text)
        clean_text = clean_text.replace('&nbsp;', ' ')
        text_report_lines.append(clean_text)
        
        # Отправка HTML во Vue
        return f"data: {json.dumps({'type': 'progress', 'msg': msg})}\n\n"

    headers = {
        'accept': 'application/json, text/plain, */*',
        'origin': BO_ORIGIN_URL,
        'referer': f"{BO_ORIGIN_URL}/",
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'x-auth-token': payload.token
    }

    brand = payload.brand.strip().lower()
    
    # --- УМНАЯ ЛОГИКА ГЕО ---
    raw_geos = [g.strip().upper() for g in payload.target_geos if g.strip()]
    if not raw_geos or "ALL" in raw_geos or "BATCH" in raw_geos:
        mode_name = "ДИНАМИЧЕСКИЙ МАССОВЫЙ РЕЖИМ"
        yield yield_log("⏳ Режим ALL: Запуск автоматического поиска активных ГЕО...")
        
        dynamic_geos = set(["ALL"]) # Всегда оставляем GLOBAL на всякий случай
        
        async def fetch_base_bonuses(query_val):
            b_list = []
            off, lim = 0, 100
            while True:
                url = (f"{BO_API_BASE_URL}/bonus"
                       f"?offset={off}&limit={lim}&filterList[isActive]=true"
                       f"&filterList[name]={query_val}&filterList[section]=casino"
                       f"&filterList[wlSlug][0]={brand}")
                try:
                    await asyncio.sleep(2.5)
                    r = requests.get(url, headers=headers)
                    if r.status_code != 200: break
                    d = r.json().get("data", [])
                    page = d if isinstance(d, list) else [d] if d else []
                    b_list.extend(page)
                    if len(page) < lim: break
                    off += lim
                except:
                    break
            return b_list
            
        # Ищем welcome 1, если пусто - ищем просто welcome
        base_bonuses = await fetch_base_bonuses("welcome+1")
        if not base_bonuses:
            base_bonuses = await fetch_base_bonuses("welcome")
            
        valid_b_count = 0
        for b in base_bonuses:
            # 1. Пропускаем внешние
            if b.get("external", False): continue
            
            # 2. Пропускаем бонусы с сегментами
            if len(b.get("segmentIdList", [])) > 0: continue
            
            # 3. Пропускаем аффилейтные
            b_aff = b.get("affiliateIdList", {}).get(brand)
            b_aff = b_aff if b_aff is not None else []
            if not isinstance(b_aff, list): b_aff = [b_aff]
            if any(a is not None and str(a).strip() != "" for a in b_aff): continue
                
            l_aff = b.get("linkToAffiliateId", {}).get(brand)
            l_aff = l_aff if l_aff is not None else []
            if not isinstance(l_aff, list): l_aff = [l_aff]
            if any(a is not None and str(a).strip() != "" for a in l_aff): continue
            
            # Бонус прошел жесткий фильтр! Забираем его ГЕО
            valid_b_count += 1
            c_list = b.get("countryList", [])
            if not c_list:
                dynamic_geos.add("ALL")
            else:
                for c in c_list:
                    dynamic_geos.add(c.upper())
                    
        target_geos = list(dynamic_geos)
        yield yield_log(f"🌍 Успешно отфильтровано базовых бонусов: {valid_b_count} шт.")
    elif len(raw_geos) > 1:
        target_geos = raw_geos
        mode_name = "МУЛЬТИ-ГЕО РЕЖИМ"
    else:
        target_geos = raw_geos
        mode_name = "ОДИНОЧНЫЙ РЕЖИМ"

    yield yield_log(f"🚀 <b>АКТИВИРОВАН {mode_name}</b>")
    yield yield_log(f"🏢 Бренд: {brand.upper()}")
    yield yield_log(f"🗺️ ГЕО: {', '.join(target_geos)}")
    yield yield_log(f"{'='*60}")

    # Загрузка сегментов для бренда
    segment_dictionary = {}
    dict_url = f"https://{brand}.{BO_BRAND_DOMAIN}/backofficeapi/{brand}/dictionary/segment?filterList[isPublished]=true"
    try:
        res = requests.get(dict_url, headers=headers)
        if res.status_code == 200:
            for seg in res.json().get("data", []):
                s_id = str(seg.get("segmentId") or seg.get("id"))
                segment_dictionary[s_id] = seg.get("name", "")
            yield yield_log(f"✅ Словарь сегментов загружен ({len(segment_dictionary)} шт.)")
    except Exception as e:
        yield yield_log(f"❌ Ошибка загрузки словаря: {e}")

    # Глобальные кэши
    MATERIAL_CACHE = {}
    BONUS_CACHE = {}
    
    # Чекбоксы из интерфейса
    check_banners = "banner" in [t.lower() for t in payload.targets]
    check_promotions = "promotion" in [t.lower() for t in payload.targets]

    # === ГЛАВНЫЙ ЦИКЛ ПО ГЕО ===
    for raw_geo in target_geos:
        # Нормализация
        geo = raw_geo
        if geo in ["DA", "DKK"]: geo = "DK"
        elif geo == "KO": geo = "KR"
        elif geo == "MKD": geo = "MK"
        elif geo == "RSD": geo = "RS"
        elif geo in ["C1", "NL"]: geo = "NL"
        elif geo in ["C2", "GB", "UK"]: geo = "GB"
        elif geo in ["C3", "SP", "ES"]: geo = "ES"
        elif geo in ["C4", "FR"]: geo = "FR"
        elif geo == "GLOBAL": geo = "ALL"

        yield yield_log(f"<br><br><b>{'#'*60}</b>")
        yield yield_log(f"<b>🚀 ЗАПУСКАЕМ АУДИТ: {brand.upper()} | ГЕО: {geo}</b>")
        yield yield_log(f"<b>{'#'*60}</b><br>")

        # === ПАМЯТЬ ЭТАЛОНОВ ===
        REFERENCE_MAX_BONUSES = {"1": {}, "2": {}, "3": {}, "4": {}, "5": {}}
        REFERENCE_PERCENTAGES = {"1": 0, "2": 0, "3": 0, "4": 0, "5": 0}
        REFERENCE_FREESPINS = {"1": 0, "2": 0, "3": 0, "4": 0, "5": 0}
        REFERENCE_IS_BONUS_ROUND = {"1": False, "2": False, "3": False, "4": False, "5": False}

        queries_to_run = [("Welcome 1", "welcome+1"), ("Welcome 2", "welcome+2"), ("Welcome 3", "welcome+3")]
        found_any_valid = False

        for phase in range(2):
            for step_name, query_val in queries_to_run:
                step_num_match = re.search(r'\d+', step_name)
                bonus_level = step_num_match.group() if step_num_match else "1"
                
                if bonus_level not in REFERENCE_MAX_BONUSES:
                    REFERENCE_MAX_BONUSES[bonus_level] = {}

                cache_key_local = f"{geo}_{query_val}"
                cache_key_global = f"ALL_{query_val}"
                
                if cache_key_local in BONUS_CACHE:
                    yield yield_log(f"⏳ Бонусы для шага: {step_name} -> ⚡ Взято из кэша ({geo})")
                    cached_data = BONUS_CACHE[cache_key_local]
                    REFERENCE_MAX_BONUSES[bonus_level] = cached_data["max_bonuses"]
                    REFERENCE_PERCENTAGES[bonus_level] = cached_data["percentage"]
                    REFERENCE_FREESPINS[bonus_level] = cached_data["freespins"]
                    REFERENCE_IS_BONUS_ROUND[bonus_level] = cached_data["is_br"]
                    found_any_valid = True
                    continue

                yield yield_log(f"⏳ Ищем бонусы в API для шага: {step_name}...")
                
                async def search_bonus_api(current_geo):
                    bonuses_list = []
                    offset, limit = 0, 100
                    has_more = True
                    while has_more:
                        api_url = (
                            f"{BO_API_BASE_URL}/bonus"
                            f"?offset={offset}&limit={limit}"
                            f"&filterList[isActive]=true"
                            f"&filterList[name]={query_val}"
                            f"&filterList[section]=casino"
                            f"&filterList[wlSlug][0]={brand}"
                        )
                        if current_geo != "ALL":
                            api_url += f"&filterList[countryList][0]={current_geo}"
                        try:
                            await asyncio.sleep(2.5)
                            response = requests.get(api_url, headers=headers)
                            if response.status_code != 200: break
                            data = response.json().get("data", [])
                            page_data = data if isinstance(data, list) else [data] if data else []
                            bonuses_list.extend(page_data)
                            if len(page_data) < limit: has_more = False
                            else: offset += limit
                        except: break
                    return bonuses_list

                bonuses = await search_bonus_api(geo)
                is_fallback_active = False
                
                # --- ЛОГИКА ФОЛБЭКА ---
                if not bonuses and geo != "ALL":
                    yield yield_log(f"&nbsp;&nbsp;&nbsp;ℹ️ Локальный бонус для {geo} не найден. 🔄 Авто-фолбэк в GLOBAL...")
                    is_fallback_active = True
                    if cache_key_global in BONUS_CACHE:
                        yield yield_log(f"&nbsp;&nbsp;&nbsp;⚡ GLOBAL бонус взят из кэша")
                        cached_data = BONUS_CACHE[cache_key_global]
                        REFERENCE_MAX_BONUSES[bonus_level] = cached_data["max_bonuses"]
                        REFERENCE_PERCENTAGES[bonus_level] = cached_data["percentage"]
                        REFERENCE_FREESPINS[bonus_level] = cached_data["freespins"]
                        REFERENCE_IS_BONUS_ROUND[bonus_level] = cached_data["is_br"]
                        BONUS_CACHE[cache_key_local] = cached_data
                        found_any_valid = True
                        continue
                    else:
                        bonuses = await search_bonus_api("ALL")

                if not bonuses:
                    yield yield_log("&nbsp;&nbsp;&nbsp;⚠️ По данному запросу активные бонусы не найдены.")
                    continue
                    
                total_found = len(bonuses)
                valid_bonuses = []

                for bonus in bonuses:
                    b_id = bonus.get("id")
                    b_name = bonus.get("name")
                    if bonus.get("external", False): continue
                    if len(bonus.get("segmentIdList", [])) > 0: continue
                    
                    check_geo = "ALL" if is_fallback_active else geo
                    if check_geo == "ALL" and len(bonus.get("countryList", [])) > 0: 
                        continue
                        
                    brand_affiliates = bonus.get("affiliateIdList", {}).get(brand)
                    brand_affiliates = brand_affiliates if brand_affiliates is not None else []
                    if not isinstance(brand_affiliates, list): brand_affiliates = [brand_affiliates]
                    if any(aff is not None and str(aff).strip() != "" for aff in brand_affiliates): continue
                        
                    link_affiliates = bonus.get("linkToAffiliateId", {}).get(brand)
                    link_affiliates = link_affiliates if link_affiliates is not None else []
                    if not isinstance(link_affiliates, list): link_affiliates = [link_affiliates]
                    if any(aff is not None and str(aff).strip() != "" for aff in link_affiliates): continue
                        
                    valid_bonuses.append((b_id, b_name))

                yield yield_log(f"&nbsp;&nbsp;&nbsp;📊 Найдено всего: {total_found} | Подошли под фильтры: {len(valid_bonuses)}")
                
                for v_id, v_name in valid_bonuses:
                    yield yield_log(f"<br>&nbsp;&nbsp;&nbsp;✅ [ID: {v_id}] {v_name}")
                    detail_url = f"{BO_API_BASE_URL}/bonus/{v_id}?brand={brand}"
                    try:
                        await asyncio.sleep(2.5)
                        res = requests.get(detail_url, headers=headers)
                        if res.status_code == 200:
                            b_data = res.json().get("data", {})
                            is_bonus_round = b_data.get("freeRoundFeature", False)
                            if "bonus round" in v_name.lower(): is_bonus_round = True
                            REFERENCE_IS_BONUS_ROUND[bonus_level] = is_bonus_round
                            fs_label = "BR" if is_bonus_round else "FS"
                            
                            yield yield_log(f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;⚙️ Вейджер: x{b_data.get('wager', 'N/A')} (FS: x{b_data.get('freeSpinWager', 'N/A')})")
                            
                            if b_data.get("isBonusLadder", False):
                                ladder_dict = b_data.get("bonusLadderStepList", {})
                                if ladder_dict:
                                    yield yield_log("&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;📈 Лесенка депозитов:")
                                    for curr, curr_data in ladder_dict.items():
                                        max_ladder_bonus, max_ladder_pct, max_ladder_fs = 0, 0, 0
                                        for i, step in enumerate(curr_data.get("steps", [])):
                                            pct = step.get("bonusDepositPercent", 0) or 0
                                            min_dep = float(step.get("minDepositAmount", 0) or 0)
                                            max_b = float(step.get("maxBonusAmount", 0) or 0)
                                            raw_fs = step.get("freeSpinCount", 0)
                                            fs = int(raw_fs) if raw_fs else 0
                                            
                                            min_dep_str = int(min_dep) if min_dep.is_integer() else min_dep
                                            max_b_str = int(max_b) if max_b.is_integer() else max_b
                                            yield yield_log(f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[{curr}] Шаг {i+1}: {pct}% | Мин: {min_dep_str} | Макс: {max_b_str} | {fs_label}: {fs}")
                                            
                                            if max_b_str > max_ladder_bonus: max_ladder_bonus = max_b_str
                                            if pct > max_ladder_pct: max_ladder_pct = pct
                                            if fs > max_ladder_fs: max_ladder_fs = fs 
                                            
                                        REFERENCE_MAX_BONUSES[bonus_level][curr] = max_ladder_bonus
                                        REFERENCE_PERCENTAGES[bonus_level] = max_ladder_pct
                                        REFERENCE_FREESPINS[bonus_level] = max_ladder_fs
                            else:
                                curr_list = b_data.get("bonusCurrencyList", [])
                                global_pct = b_data.get("depositPercent", 0) or 0
                                raw_gfs = b_data.get("freeSpinCount", 0)
                                if not raw_gfs:
                                    fs_list = b_data.get("bonusFreespinCurrencyList", [])
                                    if fs_list: raw_gfs = fs_list[0].get("freeSpinCount", 0)
                                global_fs = int(raw_gfs) if raw_gfs else 0
                                
                                REFERENCE_PERCENTAGES[bonus_level] = global_pct
                                REFERENCE_FREESPINS[bonus_level] = global_fs 
                                
                                if curr_list:
                                    yield yield_log("&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;🔹 Обычный бонус (не лесенка):")
                                    for c_data in curr_list:
                                        curr = c_data.get("currency")
                                        min_dep = float(c_data.get("minDepositAmount", 0) or 0)
                                        max_b = float(c_data.get("maxBonusAmount", 0) or 0)
                                        min_dep_str = int(min_dep) if min_dep.is_integer() else min_dep
                                        max_b_str = int(max_b) if max_b.is_integer() else max_b
                                        yield yield_log(f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[{curr}]: {global_pct}% | Мин: {min_dep_str} | Макс: {max_b_str} | {fs_label}: {global_fs}")
                                        REFERENCE_MAX_BONUSES[bonus_level][curr] = max_b_str
                        else:
                            yield yield_log(f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;❌ Ошибка доступа к деталям бонуса: {res.status_code}")
                    except Exception as e:
                        yield yield_log(f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;❌ Ошибка сети при парсинге деталей: {e}")
                
                if valid_bonuses:
                    found_any_valid = True
                    cache_data = {
                        "max_bonuses": REFERENCE_MAX_BONUSES[bonus_level],
                        "percentage": REFERENCE_PERCENTAGES[bonus_level],
                        "freespins": REFERENCE_FREESPINS[bonus_level],
                        "is_br": REFERENCE_IS_BONUS_ROUND[bonus_level]
                    }
                    BONUS_CACHE[cache_key_local] = cache_data
                    if is_fallback_active or geo == "ALL":
                        BONUS_CACHE[cache_key_global] = cache_data

            if found_any_valid: break 
            elif phase == 0:
                yield yield_log("<br>" + "-" * 60)
                yield yield_log("⚠️ Бонусы 'Welcome 1, 2, 3' не найдены!")
                yield yield_log("🔄 Запускаем фолбэк: ищем просто 'welcome'...")
                queries_to_run = [("Welcome (как 1-й шаг)", "welcome")]

        # ==========================================
        # ДОПОЛНИТЕЛЬНЫЕ ШАГИ 4 И 5 (AU, CA, NZ)
        # ==========================================
        if geo in ["AU", "CA", "NZ"]:
            yield yield_log("<br>" + "-" * 60)
            yield yield_log(f"🌍 ГЕО {geo}: Подтягиваем скрытые 4 и 5 шаги Welcome...")
            
            extra_bonuses = {
                "4": "769004606053830599",
                "5": {"AU": "442003351012364835", "CA": "307003349207083335", "NZ": "555003352686706411"}.get(geo)
            }
            
            for step_num, b_id in extra_bonuses.items():
                if not b_id: continue
                
                detail_url = f"{BO_API_BASE_URL}/bonus/{b_id}?brand={brand}"
                try:
                    await asyncio.sleep(2.5)
                    res = requests.get(detail_url, headers=headers)
                    
                    b_data = {}
                    is_valid = False
                    bonus_name = ""
                    
                    if res.status_code == 200:
                        b_data = res.json().get("data", {})
                        wl_raw_list = b_data.get("wlList", [])
                        wl_slugs = [item.get("slug", "") for item in wl_raw_list if isinstance(item, dict)]
                        
                        if brand in wl_slugs:
                            is_valid = True
                            bonus_name = b_data.get("name", f"Welcome {step_num}")
                            yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ [ID: {b_id}] Подключен скрытый {bonus_name}")
                    
                    # УМНЫЙ ПОИСК ЛОКАЛЬНОГО 5-ГО ШАГА
                    if not is_valid and step_num == "5":
                        yield yield_log(f"&nbsp;&nbsp;&nbsp;⚠️ Шаг 5 (ID {b_id}) пропущен. Ищем локальный 'Welcome 5' через API...")
                        api_url_5 = (
                            f"{BO_API_BASE_URL}/bonus"
                            f"?offset=0&limit=25&filterList[isActive]=true"
                            f"&filterList[name]=welcome+5&filterList[section]=casino"
                            f"&filterList[wlSlug][0]={brand}&filterList[countryList][0]={geo}"
                        )
                        await asyncio.sleep(2.5)
                        res_5 = requests.get(api_url_5, headers=headers)
                        if res_5.status_code == 200:
                            for b5 in res_5.json().get("data", []):
                                if "158006526162746590" not in b5.get("segmentIdList", []): continue
                                if geo not in b5.get("countryList", []): continue
                                
                                fallback_id = b5.get("id")
                                await asyncio.sleep(2.5)
                                res_det = requests.get(f"{BO_API_BASE_URL}/bonus/{fallback_id}?brand={brand}", headers=headers)
                                if res_det.status_code == 200:
                                    fb_data = res_det.json().get("data", {})
                                    f_wl_slugs = [item.get("slug", "") for item in fb_data.get("wlList", []) if isinstance(item, dict)]
                                    if brand in f_wl_slugs:
                                        b_data = fb_data
                                        is_valid = True
                                        bonus_name = fb_data.get("name", f"Welcome {step_num}")
                                        yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ [ID: {fallback_id}] Подключен локальный {bonus_name}")
                                        break

                    if not is_valid:
                        if step_num != "5":
                            yield yield_log(f"&nbsp;&nbsp;&nbsp;⚠️ Шаг {step_num} пропущен: бренд '{brand.upper()}' не найден в wlList.")
                        else:
                            yield yield_log(f"&nbsp;&nbsp;&nbsp;❌ Локальный 'Welcome 5' не найден или не прошел проверки.")
                        continue
                        
                    # ПАРСИНГ ДАННЫХ ДЛЯ 4 И 5 ШАГОВ
                    if step_num not in REFERENCE_MAX_BONUSES:
                        REFERENCE_MAX_BONUSES[step_num] = {}
                        
                    is_bonus_round = b_data.get("freeRoundFeature", False)
                    if "bonus round" in bonus_name.lower(): is_bonus_round = True
                    REFERENCE_IS_BONUS_ROUND[step_num] = is_bonus_round
                    
                    if b_data.get("isBonusLadder", False):
                        ladder_dict = b_data.get("bonusLadderStepList", {})
                        if ladder_dict:
                            for curr, curr_data in ladder_dict.items():
                                max_ladder_bonus, max_ladder_pct, max_ladder_fs = 0, 0, 0 
                                for i, step in enumerate(curr_data.get("steps", [])):
                                    pct = step.get("bonusDepositPercent", 0) or 0
                                    max_b = float(step.get("maxBonusAmount", 0) or 0)
                                    raw_fs = step.get("freeSpinCount", 0)
                                    fs = int(raw_fs) if raw_fs else 0
                                    max_b_str = int(max_b) if max_b.is_integer() else max_b
                                    
                                    if max_b_str > max_ladder_bonus: max_ladder_bonus = max_b_str
                                    if pct > max_ladder_pct: max_ladder_pct = pct
                                    if fs > max_ladder_fs: max_ladder_fs = fs 
                                    
                                REFERENCE_MAX_BONUSES[step_num][curr] = max_ladder_bonus
                                REFERENCE_PERCENTAGES[step_num] = max_ladder_pct
                                REFERENCE_FREESPINS[step_num] = max_ladder_fs
                    else:
                        curr_list = b_data.get("bonusCurrencyList", [])
                        global_pct = b_data.get("depositPercent", 0) or 0
                        raw_gfs = b_data.get("freeSpinCount", 0)
                        
                        if not raw_gfs:
                            fs_list = b_data.get("bonusFreespinCurrencyList", [])
                            if fs_list: raw_gfs = fs_list[0].get("freeSpinCount", 0)
                                
                        global_fs = int(raw_gfs) if raw_gfs else 0
                        
                        REFERENCE_PERCENTAGES[step_num] = global_pct
                        REFERENCE_FREESPINS[step_num] = global_fs 
                        
                        if curr_list:
                            for c_data in curr_list:
                                curr = c_data.get("currency")
                                max_b = float(c_data.get("maxBonusAmount", 0) or 0)
                                max_b_str = int(max_b) if max_b.is_integer() else max_b
                                REFERENCE_MAX_BONUSES[step_num][curr] = max_b_str
                except Exception as e:
                    yield yield_log(f"&nbsp;&nbsp;&nbsp;❌ Ошибка сети при парсинге шага {step_num}: {e}")

        # ==========================================
        # 6. ПОИСК И АНАЛИЗ БАННЕРОВ
        # ==========================================
        if check_banners:
            yield yield_log("<br>" + "=" * 60)
            yield yield_log("🖼️ ПОИСК И КЛАССИФИКАЦИЯ БАННЕРОВ")
            yield yield_log("=" * 60)
            
            banner_api_url = f"https://{brand}.{BO_BRAND_DOMAIN}/backofficeapi/{brand}/banner?limit=1000&offset=0&filterList[active]=true"
            yield yield_log(f"⏳ Загружаем список активных баннеров...")
            found_banners = []
            
            try:
                await asyncio.sleep(2.5)
                res_banners = requests.get(banner_api_url, headers=headers)
                if res_banners.status_code == 200:
                    banners_data = res_banners.json().get("data", [])
                    banners_list = banners_data if isinstance(banners_data, list) else [banners_data] if banners_data else []
                    found_banners_raw = []
                    
                    for b in banners_list:
                        b_name = b.get("name", "")
                        name_upper = b_name.upper()
                        if "TEST" in name_upper: continue
                        
                        dep_num = None
                        if "WP" in name_upper: dep_num = "WP"
                        elif "1ST" in name_upper: dep_num = "1st"
                        elif "2ND" in name_upper: dep_num = "2nd"
                        elif "3RD" in name_upper: dep_num = "3rd"
                        if not dep_num: continue
                        
                        all_possible_geos = re.findall(r'\b(CA|NZ|AU|KO|KR|DA|DKK|BR|IE|PT|FI|AT|BE|DE|GR|ES|IT|LU|SK|SI|PL|RO|HR|NO|AL|MK|CH|HU|CZ|BG|BA|TR|CO|MX|GB|FR|C1|C2|C3|C4|NL|UK|SP)\b', name_upper)
                        is_euro_cluster = len(all_possible_geos) >= 4
                        geo_matches = re.findall(r'\b(CA|NZ|AU|KO|KR|DA|DKK|BR|IE|PT|FI|C1|NL|C2|GB|UK|C3|ES|SP|C4|FR)\b', name_upper)
                        
                        if is_euro_cluster: geo_matches = [] 
                        
                        normalized_geos = set()
                        for g in geo_matches:
                            if g == "KO": normalized_geos.add("KR")
                            elif g in ["DA", "DKK"]: normalized_geos.add("DK")
                            elif g in ["C1", "NL"]: normalized_geos.add("NL")
                            elif g in ["C2", "GB", "UK"]: normalized_geos.add("GB")
                            elif g in ["C3", "ES", "SP"]: normalized_geos.add("ES")
                            elif g in ["C4", "FR"]: normalized_geos.add("FR")
                            else: normalized_geos.add(g)
                        
                        found_banners_raw.append({
                            "id": b.get("id") or b.get("bannerId"), 
                            "name": b_name, "dep_num": dep_num, 
                            "geos": list(normalized_geos) if normalized_geos else ["GLOBAL"]
                        })
                    
                    if geo == "ALL":
                        for b in found_banners_raw:
                            if "GLOBAL" in b["geos"]:
                                b_copy = b.copy()
                                b_copy["geo"] = "GLOBAL"
                                found_banners.append(b_copy)
                    else:
                        for step in ["WP", "1st", "2nd", "3rd"]:
                            step_banners = [b for b in found_banners_raw if b["dep_num"] == step]
                            geo_step_banners = [b for b in step_banners if geo in b["geos"]]
                            if geo_step_banners:
                                for b in geo_step_banners:
                                    b_copy = b.copy()
                                    b_copy["geo"] = geo
                                    found_banners.append(b_copy)
                            else:
                                global_step_banners = [b for b in step_banners if "GLOBAL" in b["geos"]]
                                for b in global_step_banners:
                                    b_copy = b.copy()
                                    b_copy["geo"] = "GLOBAL"
                                    found_banners.append(b_copy)
                    
                    yield yield_log(f"&nbsp;&nbsp;&nbsp;📊 Найдено целевых Welcome-баннеров: {len(found_banners)}")
                else:
                    yield yield_log(f"❌ Ошибка API при загрузке баннеров: {res_banners.status_code}")
            except Exception as e:
                yield yield_log(f"❌ Ошибка сети при загрузке баннеров: {e}")

            if found_banners:
                yield yield_log("<br>" + "=" * 60)
                yield yield_log("🕵️‍♂️ АУДИТ БАННЕРОВ: СЕГМЕНТЫ, ГЕО И СУММЫ")
                yield yield_log("=" * 60)
                
                for fb in found_banners:
                    banner_id = fb["id"]
                    banner_name = fb["name"]
                    dep_level = fb["dep_num"].replace("st", "").replace("nd", "").replace("rd", "").replace("th", "")
                    b_geo = fb["geo"]
                    
                    yield yield_log(f"<br>🔍 <b>Анализ баннера: [{b_geo}] {banner_name}</b> (ID: {banner_id})")
                    
                    try:
                        cache_key = f"banner_{banner_id}"
                        if cache_key in MATERIAL_CACHE:
                            detail_data = MATERIAL_CACHE[cache_key]
                            yield yield_log(f"&nbsp;&nbsp;&nbsp;⚡ Взято из кэша")
                        else:
                            await asyncio.sleep(2.5)
                            res_detail = requests.get(f"https://{brand}.{BO_BRAND_DOMAIN}/backofficeapi/{brand}/banner/{banner_id}", headers=headers)
                            if res_detail.status_code != 200:
                                yield yield_log(f"&nbsp;&nbsp;&nbsp;❌ Ошибка доступа: {res_detail.status_code}")
                                continue
                            detail_data = res_detail.json().get("data", {})
                            MATERIAL_CACHE[cache_key] = detail_data
                        
                        # --- 1. СЕГМЕНТЫ ---
                        actual_segment_names = []
                        raw_segments = detail_data.get("segmentList", []) if "segmentList" in detail_data else detail_data.get("segmentIdList", [])
                        for seg in raw_segments:
                            s_id = str(seg.get("segmentId") or seg.get("id") if isinstance(seg, dict) else seg)
                            actual_segment_names.append(segment_dictionary.get(s_id, f"Unknown_{s_id}").lower())
                            
                        yield yield_log(f"&nbsp;&nbsp;&nbsp;📎 Сегменты: {', '.join(actual_segment_names) if actual_segment_names else 'ПУСТО'}")
                        real_segments = [s for s in actual_segment_names if "content qa test account" not in s]
                        
                        if dep_level == "1" or dep_level == "WP":
                            if real_segments: 
                                yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Для 1-го депозита сегменты ДОЛЖНЫ БЫТЬ ПУСТЫМИ. Найдено лишнее: {real_segments}</span>")
                            else: 
                                yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Боевые сегменты пустые.")
                        elif dep_level in ["2", "3", "4", "5"]:
                            expected_num_word = NUM_TO_WORD.get(dep_level, "")
                            target_country_lower = "all" if b_geo == "GLOBAL" else b_geo.lower()
                            found_target_segment = False
                            target_segment_full_name = ""
                            for seg_name in actual_segment_names:
                                if target_country_lower in seg_name and expected_num_word in seg_name and "banners" in seg_name:
                                    found_target_segment = True
                                    target_segment_full_name = seg_name
                                    break
                            if not found_target_segment:
                                yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Отсутствует критический сегмент для [{target_country_lower.upper()} {expected_num_word} banners]</span>")
                            else:
                                yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Найден сегмент '{target_segment_full_name.title()}'")
                        
                        # --- 2. COUNTRY LIST ---
                        b_country_list = detail_data.get("countryList", [])
                        b_excluded_list = detail_data.get("excludedCountryList", [])
                        
                        if b_geo == "GLOBAL":
                            if not b_country_list: yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: 'countryList' пуст.")
                            else: yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: 'countryList' ДОЛЖЕН БЫТЬ ПУСТЫМ.</span>")
                            if b_excluded_list:
                                found_locals = []
                                missing_locals = []
                                for ex_c in b_excluded_list:
                                    has_local = any(ex_c in b["geos"] and b["dep_num"] == fb["dep_num"] for b in found_banners_raw)
                                    if has_local: found_locals.append(ex_c)
                                    else: missing_locals.append(ex_c)
                                if found_locals: yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Локальные баннеры для исключений есть: {', '.join(found_locals)}")
                                if missing_locals: yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Страны {missing_locals} в исключениях, но локалок НЕТ!</span>")
                        else:
                            if b_geo in b_country_list: yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Страна {b_geo} в 'countryList'.")
                            else: yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Страна {b_geo} ОТСУТСТВУЕТ в 'countryList'!</span>")

                        # --- 2.5 ЛОКАЛИ ---
                        banner_locales = set()
                        for field in ["buttonText", "upperText", "middleText", "lowerText", "unregisteredButtonText"]:
                            field_data = detail_data.get(field, {})
                            if isinstance(field_data, dict): banner_locales.update(field_data.keys())
                        
                        if banner_locales:
                            chk_geo = "ALL" if geo in ["ALL", "GLOBAL"] else ("MK" if geo == "MKD" else "RS" if geo == "RSD" else geo)
                            req_locales = GEO_TO_LOCALES.get(chk_geo, [])
                            if req_locales:
                                found_req = [loc for loc in req_locales if loc in banner_locales]
                                if found_req: yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Необходимая локаль присутствует ({', '.join(found_req)}).")
                                else: yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Отсутствует локаль! Ожидалось из: {req_locales}</span>")
                        else:
                            yield yield_log(f"&nbsp;&nbsp;&nbsp;⚠️ ПРЕДУПРЕЖДЕНИЕ: В баннере не найдены локализации (языки)!")

                        # --- 3 & 4. VALUES CONFIG & TEXTS ---
                        b_values = detail_data.get("valuesConfiguration", {})
                        if not b_values:
                            yield yield_log(f"&nbsp;&nbsp;&nbsp;ℹ️ ИНФО: 'valuesConfiguration' пуст. Ищем суммы в текстах...")
                            all_texts = []
                            for field in ["buttonText", "upperText", "middleText", "lowerText", "unregisteredButtonText"]:
                                field_data = detail_data.get(field, {})
                                if isinstance(field_data, dict): all_texts.extend(str(v) for v in field_data.values())
                            
                            combined_text = re.sub(r'<[^>]+>', ' ', " ".join(all_texts))
                            normalized_text = re.sub(r'(?<=\d)[.,](?=\d{3})', '', combined_text)
                            found_numbers = set(int(m) for m in re.findall(r'\b(\d+)\b', normalized_text))
                            
                            if dep_level != "WP":
                                ref_dict = REFERENCE_MAX_BONUSES.get(dep_level, {})
                                for curr, expected_amount in ref_dict.items():
                                    if expected_amount == 0: continue 
                                    if curr == "EUR" or (len(b_country_list) == 1 and curr != "EUR"):
                                        if expected_amount in found_numbers:
                                            yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Сумма {curr} найдена в текстах ({expected_amount}).")
                                        else:
                                            eur_geos = ["GLOBAL", "ALL", "FI", "IE", "PT", "DE", "AT", "GR", "ES", "IT", "SK", "SI", "FR", "NL", "BE", "GB"]
                                            if curr == "EUR" and b_geo not in eur_geos:
                                                yield yield_log(f"&nbsp;&nbsp;&nbsp;🟡 ОБРАТИТЕ ВНИМАНИЕ: Сумма {curr} ({expected_amount}) не найдена. (Допустимо для локалки)")
                                            else:
                                                yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Сумма {curr} не найдена в текстах! Ожидалось: {expected_amount}</span>")
                        else:
                            for curr, vals in b_values.items():
                                if dep_level == "WP":
                                    expected_amount = sum(REFERENCE_MAX_BONUSES[step].get(curr, 0) for step in REFERENCE_MAX_BONUSES)
                                    if expected_amount == 0 and all(curr not in REFERENCE_MAX_BONUSES[step] for step in REFERENCE_MAX_BONUSES):
                                        expected_amount = None
                                else:
                                    ref_dict = REFERENCE_MAX_BONUSES.get(dep_level, {})
                                    expected_amount = ref_dict.get(curr)
                                
                                found_match = False
                                banner_amounts = []
                                for item in vals:
                                    clean_val_str = re.sub(r'[^\d]', '', str(item.get("value", "")))
                                    if clean_val_str:
                                        banner_amount = int(clean_val_str)
                                        banner_amounts.append(banner_amount)
                                        if expected_amount and banner_amount == expected_amount:
                                            found_match = True
                                            
                                if expected_amount:
                                    if found_match: 
                                        yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Сумма {curr} совпадает с бонусом ({expected_amount}).")
                                    else: 
                                        eur_geos = ["GLOBAL", "ALL", "FI", "IE", "PT", "DE", "AT", "GR", "ES", "IT", "SK", "SI", "FR", "NL", "BE"]
                                        if curr == "EUR" and b_geo not in eur_geos:
                                            yield yield_log(f"&nbsp;&nbsp;&nbsp;🟡 ОБРАТИТЕ ВНИМАНИЕ: Расхождение {curr}! Баннер: {banner_amounts}, бонус: {expected_amount} (Допустимо)")
                                        else:
                                            yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Расхождение {curr}! Баннер: {banner_amounts}, бонус: {expected_amount}</span>")
                                else:
                                    if len(b_country_list) > 1 or b_geo == "GLOBAL":
                                        yield yield_log(f"&nbsp;&nbsp;&nbsp;ℹ️ ИНФО: Валюта {curr} пропущена (мульти-список).")
                                    else:
                                        yield yield_log(f"&nbsp;&nbsp;&nbsp;⚠️ ПРЕДУПРЕЖДЕНИЕ: Валюта {curr} есть в баннере, но эталон для неё не найден!")

                        # 4. Проверка FS и % в текстах
                        text_fields = ["buttonText", "upperText", "middleText", "lowerText", "unregisteredButtonText"]
                        found_pcts, found_fs, found_br = set(), set(), set()
                        lang_texts = {}
                        for field in text_fields:
                            field_data = detail_data.get(field, {})
                            if isinstance(field_data, dict):
                                for lang, text_val in field_data.items():
                                    if lang not in lang_texts: lang_texts[lang] = []
                                    lang_texts[lang].append(str(text_val))
                                    
                        for lang, texts in lang_texts.items():
                            val_str = re.sub(r'<[^>]+>', ' ', " ".join(texts))
                            for m in re.findall(r'(\d+)\s*%', val_str): found_pcts.add(int(m))
                            for m in re.findall(r'\b(\d+)\s*(?:Free\s*Spins|FS|Rodadas|Giros|Spins|Freispiele|Kierrosta|무료\s*스핀|Завъртания|okretaja|Spinów|Rotiri|Spinov|Vrtljaji|Rrotullime|spinovi|Спинови|Zatočení|Pörgetés)', val_str, re.IGNORECASE): found_fs.add(int(m))
                            for m in re.findall(r'\b(\d+)\s*(?:Bonus\s*Rounds?|\bBR\b)', val_str, re.IGNORECASE): found_br.add(int(m))

                        if found_pcts:
                            if dep_level == "WP": yield yield_log(f"&nbsp;&nbsp;&nbsp;ℹ️ ИНФО: Проценты {[f'{p}%' for p in found_pcts]} пропущены для WP.")
                            else:
                                expected_pct = REFERENCE_PERCENTAGES.get(dep_level, 0)
                                if expected_pct in found_pcts: yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Процент совпадает ({expected_pct}%).")
                                else: yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Расхождение %! Текст: {[f'{p}%' for p in found_pcts]}, Бонус: {expected_pct}%</span>")

                        expected_fs_count = 0
                        expected_br_count = 0
                        if dep_level == "WP":
                            for step in REFERENCE_FREESPINS:
                                val = int(REFERENCE_FREESPINS[step]) if REFERENCE_FREESPINS[step] else 0
                                if REFERENCE_IS_BONUS_ROUND.get(step, False): expected_br_count += val
                                else: expected_fs_count += val
                        else:
                            val = int(REFERENCE_FREESPINS.get(dep_level, 0) or 0)
                            if REFERENCE_IS_BONUS_ROUND.get(dep_level, False): expected_br_count = val
                            else: expected_fs_count = val
                        
                        if expected_fs_count > 0:
                            if expected_fs_count in found_fs: yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Фриспины совпадают ({expected_fs_count} FS).")
                            elif not found_fs: yield yield_log(f"&nbsp;&nbsp;&nbsp;⚠️ ПРЕДУПРЕЖДЕНИЕ: Ожидалось {expected_fs_count} FS, но в текстах их нет.")
                            else: yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Расхождение FS! Текст: {list(found_fs)}, Ожидалось: {expected_fs_count} FS</span>")
                        elif found_fs and expected_br_count == 0:
                            yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Указаны {list(found_fs)} FS, но бонус их не дает!</span>")

                    except Exception as e:
                        yield yield_log(f"&nbsp;&nbsp;&nbsp;❌ Ошибка при парсинге баннера: {e}")

        # ==========================================
        # 8. ПОИСК И АНАЛИЗ ПРОМО-КАРТ
        # ==========================================
        if check_promotions:
            yield yield_log("<br>" + "=" * 60)
            yield yield_log("🃏 ПОИСК И КЛАССИФИКАЦИЯ ПРОМО-КАРТ")
            yield yield_log("=" * 60)
            
            promo_api_url = f"https://{brand}.{BO_BRAND_DOMAIN}/backofficeapi/{brand}/promotion?limit=1000&offset=0&filterList[active]=true"
            yield yield_log(f"⏳ Загружаем список активных промо-карт...")
            found_promos = []
            
            try:
                await asyncio.sleep(2.5)
                res_promos = requests.get(promo_api_url, headers=headers)
                if res_promos.status_code == 200:
                    promos_data = res_promos.json().get("data", [])
                    promos_list = promos_data if isinstance(promos_data, list) else [promos_data] if promos_data else []
                    found_promos_raw = []
                    
                    for p in promos_list:
                        p_name = p.get("name", "")
                        name_upper = p_name.upper()
                        if "SPORT" in name_upper or "TEST" in name_upper: continue
                        
                        dep_num = None
                        if "WP" in name_upper: dep_num = "WP"
                        elif "1ST" in name_upper: dep_num = "1st"
                        elif "2ND" in name_upper: dep_num = "2nd"
                        elif "3RD" in name_upper: dep_num = "3rd"
                        if not dep_num: continue
                        
                        all_possible_geos = re.findall(r'\b(CA|NZ|AU|KO|KR|DA|DKK|BR|IE|PT|FI|AT|BE|DE|GR|ES|IT|LU|SK|SI|PL|RO|HR|NO|AL|MK|CH|HU|CZ|BG|BA|TR|CO|MX|GB|FR|C1|C2|C3|C4|NL|UK|SP)\b', name_upper)
                        is_euro_cluster = len(all_possible_geos) >= 4
                        geo_matches = re.findall(r'\b(CA|NZ|AU|KO|KR|DA|DKK|BR|IE|PT|FI|C1|NL|C2|GB|UK|C3|ES|SP|C4|FR)\b', name_upper)
                        
                        if is_euro_cluster: geo_matches = []  
                        
                        normalized_geos = set()
                        for g in geo_matches:
                            if g == "KO": normalized_geos.add("KR")
                            elif g in ["DA", "DKK"]: normalized_geos.add("DK")
                            elif g in ["C1", "NL"]: normalized_geos.add("NL")
                            elif g in ["C2", "GB", "UK"]: normalized_geos.add("GB")
                            elif g in ["C3", "ES", "SP"]: normalized_geos.add("ES")
                            elif g in ["C4", "FR"]: normalized_geos.add("FR")
                            else: normalized_geos.add(g)
                        
                        found_promos_raw.append({
                            "id": p.get("id"), "name": p_name, 
                            "dep_num": dep_num, "geos": list(normalized_geos) if normalized_geos else ["GLOBAL"]
                        })
                    
                    if geo == "ALL":
                        for p in found_promos_raw:
                            if "GLOBAL" in p["geos"]:
                                p_copy = p.copy()
                                p_copy["geo"] = "GLOBAL"
                                found_promos.append(p_copy)
                    else:
                        for step in ["WP", "1st", "2nd", "3rd"]:
                            step_promos = [p for p in found_promos_raw if p["dep_num"] == step]
                            geo_step_promos = [p for p in step_promos if geo in p["geos"]]
                            if geo_step_promos:
                                for p in geo_step_promos:
                                    p_copy = p.copy()
                                    p_copy["geo"] = geo
                                    found_promos.append(p_copy)
                            else:
                                global_step_promos = [p for p in step_promos if "GLOBAL" in p["geos"]]
                                for p in global_step_promos:
                                    p_copy = p.copy()
                                    p_copy["geo"] = "GLOBAL"
                                    found_promos.append(p_copy)
                    
                    yield yield_log(f"&nbsp;&nbsp;&nbsp;📊 Найдено целевых Промо-карт: {len(found_promos)}")
                else:
                    yield yield_log(f"❌ Ошибка API при загрузке промо-карт: {res_promos.status_code}")
            except Exception as e:
                yield yield_log(f"❌ Ошибка сети при загрузке промо-карт: {e}")

            if found_promos:
                yield yield_log("<br>" + "=" * 60)
                yield yield_log("🕵️‍♂️ АУДИТ ПРОМО-КАРТ: СЕГМЕНТЫ, ГЕО И СУММЫ")
                yield yield_log("=" * 60)
                
                for fp in found_promos:
                    promo_id = fp["id"]
                    promo_name = fp["name"]
                    dep_level = fp["dep_num"].replace("st", "").replace("nd", "").replace("rd", "").replace("th", "")
                    p_geo = fp["geo"]
                    
                    yield yield_log(f"<br>🔍 <b>Анализ промо-карты: [{p_geo}] {promo_name}</b> (ID: {promo_id})")
                    
                    try:
                        cache_key = f"promo_{promo_id}"
                        if cache_key in MATERIAL_CACHE:
                            detail_data = MATERIAL_CACHE[cache_key]
                            yield yield_log(f"&nbsp;&nbsp;&nbsp;⚡ Взято из кэша")
                        else:
                            await asyncio.sleep(2.5)
                            res_detail = requests.get(f"https://{brand}.{BO_BRAND_DOMAIN}/backofficeapi/{brand}/promotion/{promo_id}", headers=headers)
                            if res_detail.status_code != 200:
                                yield yield_log(f"&nbsp;&nbsp;&nbsp;❌ Ошибка доступа: {res_detail.status_code}")
                                continue
                            detail_data = res_detail.json().get("data", {})
                            MATERIAL_CACHE[cache_key] = detail_data
                        
                        # --- 1. СЕГМЕНТЫ ---
                        actual_segment_names = []
                        raw_segments = detail_data.get("segmentIdList", [])
                        for seg in raw_segments:
                            s_id = str(seg.get("segmentId") or seg.get("id") if isinstance(seg, dict) else seg)
                            actual_segment_names.append(segment_dictionary.get(s_id, f"Unknown_{s_id}").lower())
                            
                        yield yield_log(f"&nbsp;&nbsp;&nbsp;📎 Сегменты: {', '.join(actual_segment_names) if actual_segment_names else 'ПУСТО'}")
                        real_segments = [s for s in actual_segment_names if "content qa test account" not in s]
                        
                        if dep_level == "1" or dep_level == "WP":
                            if real_segments: 
                                yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Для 1-го депозита сегменты ДОЛЖНЫ БЫТЬ ПУСТЫМИ. Найдено лишнее: {real_segments}</span>")
                            else: 
                                yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Боевые сегменты пустые.")
                        elif dep_level in ["2", "3", "4", "5"]:
                            expected_num_word = NUM_TO_WORD.get(dep_level, "")
                            target_country_lower = "all" if p_geo == "GLOBAL" else p_geo.lower()
                            found_target_segment = False
                            target_segment_full_name = ""
                            for seg_name in actual_segment_names:
                                if target_country_lower in seg_name and expected_num_word in seg_name and "promocards" in seg_name:
                                    found_target_segment = True
                                    target_segment_full_name = seg_name
                                    break
                            if not found_target_segment:
                                yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Отсутствует критический сегмент для [{target_country_lower.upper()} {expected_num_word} promocards]</span>")
                            else:
                                yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Найден сегмент '{target_segment_full_name.title()}'")
                        
                        # --- 2. COUNTRY LIST ---
                        p_country_list = detail_data.get("countryList", [])
                        p_excluded_list = detail_data.get("excludedCountryList", [])
                        
                        if p_geo == "GLOBAL":
                            if not p_country_list: yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: 'countryList' пуст.")
                            else: yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: 'countryList' ДОЛЖЕН БЫТЬ ПУСТЫМ.</span>")
                            if p_excluded_list:
                                found_locals = []
                                missing_locals = []
                                for ex_c in p_excluded_list:
                                    has_local = any(ex_c in p["geos"] and p["dep_num"] == fp["dep_num"] for p in found_promos_raw)
                                    if has_local: found_locals.append(ex_c)
                                    else: missing_locals.append(ex_c)
                                if found_locals: yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Локальные промо-карты для исключений есть: {', '.join(found_locals)}")
                                if missing_locals: yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Страны {missing_locals} в исключениях, но локалок НЕТ!</span>")
                        else:
                            if p_geo in p_country_list: yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Страна {p_geo} в 'countryList'.")
                            else: yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Страна {p_geo} ОТСУТСТВУЕТ в 'countryList'!</span>")

                        # --- 2.5 ЛОКАЛИ ---
                        promo_locales = set()
                        for field in ["titleText", "promotionPrizeFirst", "promotionPrizeSecond", "promotionButtonText", "promotionBacksideButtonText", "unregisteredPromotionButtonText"]:
                            field_data = detail_data.get(field, {})
                            if isinstance(field_data, dict): promo_locales.update(field_data.keys())
                        
                        if promo_locales:
                            chk_geo = "ALL" if geo in ["ALL", "GLOBAL"] else ("MK" if geo == "MKD" else "RS" if geo == "RSD" else geo)
                            req_locales = GEO_TO_LOCALES.get(chk_geo, [])
                            if req_locales:
                                found_req = [loc for loc in req_locales if loc in promo_locales]
                                if found_req: yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Необходимая локаль присутствует ({', '.join(found_req)}).")
                                else: yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Отсутствует локаль! Ожидалось из: {req_locales}</span>")
                        else:
                            yield yield_log(f"&nbsp;&nbsp;&nbsp;⚠️ ПРЕДУПРЕЖДЕНИЕ: В промо-карте не найдены локализации (языки)!")

                        # --- 3. ДЕБАГГЕР ---
                        yield yield_log(f"&nbsp;&nbsp;&nbsp;🛠️ ДЕБАГ: Структура оффера (Язык: EN)")
                        val_config = detail_data.get("valuesConfiguration", {})
                        prize1 = detail_data.get("promotionPrizeFirst", {}).get("en", "N/A")
                        prize2 = detail_data.get("promotionPrizeSecond", {}).get("en", "N/A")
                        yield yield_log(f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; - Prize 1: {prize1}")
                        yield yield_log(f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; - Prize 2: {prize2}")
                        
                        backside_table = detail_data.get("backsideTableText", {}).get("en", [])
                        if backside_table:
                            yield yield_log("&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; - backsideTableText:")
                            for row in backside_table:
                                row_key = row.get("key", "N/A")
                                row_slug = row.get("value", "N/A")
                                resolved_vals = []
                                for v in val_config.get("EUR", []):
                                    if v.get("slug") == row_slug: resolved_vals.append(f"EUR: {v.get('value')}")
                                for curr, v_list in val_config.items():
                                    if curr == "EUR": continue
                                    for v in v_list:
                                        if v.get("slug") == row_slug: resolved_vals.append(f"{curr}: {v.get('value')}")
                                resolved_str = " | ".join(resolved_vals[:3])
                                if not resolved_str: resolved_str = "Значение не найдено"
                                yield yield_log(f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[ТЕКСТ]: '{row_key}' -> [МАКРОС]: {row_slug} -> [ФАКТ]: {resolved_str}")

                        # --- 4. ПРОВЕРКА СУММ ---
                        yield yield_log(f"&nbsp;&nbsp;&nbsp;⚙️ СВЕРКА:")
                        if not val_config:
                            yield yield_log(f"&nbsp;&nbsp;&nbsp;ℹ️ ИНФО: 'valuesConfiguration' пуст. Ищем суммы в текстах...")
                            all_texts = []
                            for field in ["promotionPrizeFirst", "promotionPrizeSecond", "titleText", "promotionButtonText"]:
                                field_data = detail_data.get(field, {})
                                if isinstance(field_data, dict): all_texts.extend(str(v) for v in field_data.values())
                            
                            backside_table_all = detail_data.get("backsideTableText", {})
                            if isinstance(backside_table_all, dict):
                                for lang, rows in backside_table_all.items():
                                    for row in rows:
                                        all_texts.append(str(row.get("key", "")))
                                        all_texts.append(str(row.get("value", "")))
                            
                            combined_text = re.sub(r'<[^>]+>', ' ', " ".join(all_texts))
                            normalized_text = re.sub(r'(?<=\d)[.,](?=\d{3})', '', combined_text)
                            found_numbers = set(int(m) for m in re.findall(r'\b(\d+)\b', normalized_text))
                            
                            if dep_level != "WP":
                                ref_dict = REFERENCE_MAX_BONUSES.get(dep_level, {})
                                for curr, expected_amount in ref_dict.items():
                                    if expected_amount == 0: continue 
                                    if curr == "EUR" or (len(p_country_list) == 1 and curr != "EUR"):
                                        if expected_amount in found_numbers:
                                            yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Сумма {curr} найдена в текстах ({expected_amount}).")
                                        else:
                                            eur_geos = ["GLOBAL", "ALL", "FI", "IE", "PT", "DE", "AT", "GR", "ES", "IT", "SK", "SI", "FR", "NL", "BE", "GB"]
                                            if curr == "EUR" and p_geo not in eur_geos:
                                                yield yield_log(f"&nbsp;&nbsp;&nbsp;🟡 ОБРАТИТЕ ВНИМАНИЕ: Сумма {curr} ({expected_amount}) не найдена. (Допустимо для локалки)")
                                            else:
                                                yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Сумма {curr} не найдена в текстах! Ожидалось: {expected_amount}</span>")
                        else:
                            for curr, vals in val_config.items():
                                if dep_level == "WP":
                                    expected_amount = sum(REFERENCE_MAX_BONUSES[step].get(curr, 0) for step in REFERENCE_MAX_BONUSES)
                                    if expected_amount == 0 and all(curr not in REFERENCE_MAX_BONUSES[step] for step in REFERENCE_MAX_BONUSES):
                                        expected_amount = None
                                else:
                                    ref_dict = REFERENCE_MAX_BONUSES.get(dep_level, {})
                                    expected_amount = ref_dict.get(curr)
                                
                                found_match = False
                                promo_amounts = []
                                for item in vals:
                                    clean_val_str = re.sub(r'[^\d]', '', str(item.get("value", "")))
                                    if clean_val_str:
                                        p_amt = int(clean_val_str)
                                        promo_amounts.append(p_amt)
                                        if expected_amount and p_amt == expected_amount:
                                            found_match = True
                                            
                                if expected_amount:
                                    if found_match: 
                                        yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Сумма {curr} совпадает с бонусом ({expected_amount}).")
                                    else: 
                                        eur_geos = ["GLOBAL", "ALL", "FI", "IE", "PT", "DE", "AT", "GR", "ES", "IT", "SK", "SI", "FR", "NL", "BE"]
                                        if curr == "EUR" and p_geo not in eur_geos:
                                            yield yield_log(f"&nbsp;&nbsp;&nbsp;🟡 ОБРАТИТЕ ВНИМАНИЕ: Расхождение {curr}! Карта: {promo_amounts}, бонус: {expected_amount} (Допустимо)")
                                        else:
                                            yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Расхождение {curr}! Карта: {promo_amounts}, бонус: {expected_amount}</span>")
                                else:
                                    if len(p_country_list) > 1 or p_geo == "GLOBAL":
                                        yield yield_log(f"&nbsp;&nbsp;&nbsp;ℹ️ ИНФО: Валюта {curr} пропущена (мульти-список).")
                                    else:
                                        yield yield_log(f"&nbsp;&nbsp;&nbsp;⚠️ ПРЕДУПРЕЖДЕНИЕ: Валюта {curr} есть в промо-карте, но эталон для неё не найден!")

                        # --- 5. ПРОВЕРКА КОНТЕНТА (ПРОЦЕНТЫ, FS) ---
                        text_fields = ["promotionPrizeFirst", "promotionPrizeSecond", "titleText", "promotionButtonText"]
                        found_pcts, found_fs, found_br = set(), set(), set()
                        lang_texts = {}
                        for field in text_fields:
                            field_data = detail_data.get(field, {})
                            if isinstance(field_data, dict):
                                for lang, text_val in field_data.items():
                                    if lang not in lang_texts: lang_texts[lang] = []
                                    lang_texts[lang].append(str(text_val))
                        
                        backside_table_all = detail_data.get("backsideTableText", {})
                        if isinstance(backside_table_all, dict):
                            for lang, rows in backside_table_all.items():
                                if lang not in lang_texts: lang_texts[lang] = []
                                for row in rows:
                                    lang_texts[lang].append(str(row.get("key", "")))
                        
                        for lang, texts in lang_texts.items():
                            val_str = re.sub(r'<[^>]+>', ' ', " ".join(texts))
                            for m in re.findall(r'(\d+)\s*%', val_str): found_pcts.add(int(m))
                            for m in re.findall(r'\b(\d+)\s*(?:Free\s*Spins|FS|Rodadas|Giros|Spins|Freispiele|Kierrosta|무료\s*스핀|Завъртания|okretaja|Spinów|Rotiri|Spinov|Vrtljaji|Rrotullime|spinovi|Спинови|Zatočení|Pörgetés)', val_str, re.IGNORECASE): found_fs.add(int(m))
                            for m in re.findall(r'\b(\d+)\s*(?:Bonus\s*Rounds?|\bBR\b)', val_str, re.IGNORECASE): found_br.add(int(m))

                        if found_pcts:
                            if dep_level == "WP": yield yield_log(f"&nbsp;&nbsp;&nbsp;ℹ️ ИНФО: Проценты {[f'{p}%' for p in found_pcts]} пропущены для WP.")
                            else:
                                expected_pct = REFERENCE_PERCENTAGES.get(dep_level, 0)
                                if expected_pct in found_pcts: yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Процент совпадает ({expected_pct}%).")
                                else: yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Расхождение %! Текст: {[f'{p}%' for p in found_pcts]}, Бонус: {expected_pct}%</span>")

                        expected_fs_count = 0
                        expected_br_count = 0
                        if dep_level == "WP":
                            for step in REFERENCE_FREESPINS:
                                val = int(REFERENCE_FREESPINS[step]) if REFERENCE_FREESPINS[step] else 0
                                if REFERENCE_IS_BONUS_ROUND.get(step, False): expected_br_count += val
                                else: expected_fs_count += val
                        else:
                            val = int(REFERENCE_FREESPINS.get(dep_level, 0) or 0)
                            if REFERENCE_IS_BONUS_ROUND.get(dep_level, False): expected_br_count = val
                            else: expected_fs_count = val
                        
                        if expected_fs_count > 0:
                            if expected_fs_count in found_fs: yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Фриспины совпадают ({expected_fs_count} FS).")
                            elif not found_fs: yield yield_log(f"&nbsp;&nbsp;&nbsp;⚠️ ПРЕДУПРЕЖДЕНИЕ: Ожидалось {expected_fs_count} FS, но в текстах их нет.")
                            else: yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Расхождение FS! Текст: {list(found_fs)}, Ожидалось: {expected_fs_count} FS</span>")

                        if expected_br_count > 0:
                            if expected_br_count in found_br: yield yield_log(f"&nbsp;&nbsp;&nbsp;✅ ИДЕАЛЬНО: Bonus Rounds совпадают ({expected_br_count} BR).")
                            elif not found_br: yield yield_log(f"&nbsp;&nbsp;&nbsp;⚠️ ПРЕДУПРЕЖДЕНИЕ: Ожидалось {expected_br_count} BR, но в текстах их нет.")
                            else: yield yield_log(f"&nbsp;&nbsp;&nbsp;<span style='color:#ef4444; font-weight:bold;'>🛑 ОШИБКА: Расхождение BR! Текст: {list(found_br)}, Ожидалось: {expected_br_count} BR</span>")

                    except Exception as e:
                        yield yield_log(f"&nbsp;&nbsp;&nbsp;❌ Ошибка при парсинге промо-карты: {e}")

    yield yield_log("<br>🏁 <b>ПОЛНЫЙ АУДИТ ЗАВЕРШЕН!</b>")

    # Формируем и отдаем текстовый файл для скачивания
    final_text_content = "\n".join(text_report_lines)
    file_name = f"BO_Audit_{payload.brand.upper()}.txt"
    yield f"data: {json.dumps({'type': 'done', 'html_content': final_text_content, 'filename': file_name})}\n\n"