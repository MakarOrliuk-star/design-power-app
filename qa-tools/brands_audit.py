import requests
import json
import re
import html
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List

router = APIRouter(tags=["Brands Audit"])

# =====================================================================
# 📦 PYDANTIC СХЕМЫ (Входящие данные)
# =====================================================================
class CampaignSearchRequest(BaseModel):
    urls: List[str]
    keyword: str
    token: str

class BulkLabelsRequest(BaseModel):
    env: str  # "env2", "env5", "env7"
    keyword: str
    labels: List[str]
    token: str

class ResolveLinksRequest(BaseModel):
    env: str
    keyword: str
    items: List[str]
    token: str

# Константы окружений
DEFAULT_BRANDS = {"env2": "2828", "env5": "20115", "env7": "28111"}
HOST_MAP = {"env2": "boapi.smartico.ai", "env5": "boapi5.smartico.ai", "env7": "boapi7.smartico.ai"}

# =====================================================================
# 🧠 БИЗНЕС-ЛОГИКА (Очищено от Streamlit)
# =====================================================================
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
                raise ValueError(f"Ошибка API: {res.status_code}")
        except Exception as e:
            raise ValueError(f"Критическая ошибка запроса: {e}")

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
                        results[original_name] = fallback_all_users_val + " (Default / All Users)"
                    else:
                        results[original_name] = "⚠️ Вариация не найдена"
                        
                except Exception as e:
                    results[original_name] = f"❌ Ошибка: {str(e)}"
                    
        return results

def resolve_short_url(raw_val):
    url = str(raw_val).split(" (Default")[0].strip()
    if not url: return "⚠️ Пусто"
    if "." not in url: return "⚠️ Не похоже на ссылку"
    if not url.startswith('http'): url = 'https://' + url
        
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
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
            matches.append({"path": path, "value": val_str})
    return matches

# =====================================================================
# 🚀 ЭНДПОИНТЫ API
# =====================================================================

@router.post("/search-campaigns")
def search_campaigns(request: CampaignSearchRequest):
    """(Вкладка 1) Ищет ключевое слово (название бренда) в настройках кампаний"""
    raw_text = "\n".join(request.urls)
    campaigns = parse_input_to_campaigns(raw_text)
    
    if not campaigns:
        raise HTTPException(status_code=400, detail="Ссылки Smartico не обнаружены.")

    results = []
    for camp in campaigns:
        engine = BrandAuditorEngine(camp["brand_id"], camp["host"], request.token)
        meta = engine.get_campaign_metadata(camp["camp_id"], camp["is_pop"])
        
        if meta == "UNAUTHORIZED":
            raise HTTPException(status_code=401, detail=f"Токен для {camp['env']} протух или недействителен.")
            
        if meta:
            matches = search_keyword_in_dict(meta, request.keyword)
            unique_matches = []
            seen_values = set()
            
            for m in matches:
                norm_val = " ".join(str(m["value"]).split())
                if norm_val not in seen_values:
                    seen_values.add(norm_val)
                    unique_matches.append(m)
                    
            camp_name = meta.get('audience_name', meta.get('name', 'Unnamed'))
            results.append({
                "campaign_id": camp["camp_id"],
                "url": camp["url"],
                "name": camp_name,
                "matches": unique_matches
            })
            
    return {"status": "success", "results": results}


@router.post("/bulk-labels")
def bulk_labels(request: BulkLabelsRequest):
    """(Вкладка 2) Массово вытаскивает значения лейблов для конкретного бренда"""
    parsed_labels = parse_labels_input("\n".join(request.labels))
    if not parsed_labels:
        raise HTTPException(status_code=400, detail="Лейблы не распознаны.")
        
    brand_id = DEFAULT_BRANDS.get(request.env)
    host = HOST_MAP.get(request.env)
    if not brand_id or not host:
        raise HTTPException(status_code=400, detail="Неверное окружение.")
        
    engine = BrandAuditorEngine(brand_id, host, request.token)
    results = engine.get_bulk_label_values(parsed_labels, request.keyword)
    
    if results == "UNAUTHORIZED":
        raise HTTPException(status_code=401, detail="Токен авторизации протух.")
        
    return {"status": "success", "results": results}


@router.post("/resolve-links")
def resolve_links(request: ResolveLinksRequest):
    """(Вкладка 3) Парсит лейблы и шортлинки, раскрывая их через редиректы"""
    parsed_items = parse_labels_input("\n".join(request.items))
    if not parsed_items:
        raise HTTPException(status_code=400, detail="Данные не распознаны.")
        
    brand_id = DEFAULT_BRANDS.get(request.env)
    host = HOST_MAP.get(request.env)
    
    labels_to_fetch = []
    resolved_links = {}

    for item in parsed_items:
        if "." in item:
            resolved_links[item] = {"short": item, "full": "", "status": "ok"}
        else:
            labels_to_fetch.append(item)
            
    if labels_to_fetch:
        engine = BrandAuditorEngine(brand_id, host, request.token)
        results = engine.get_bulk_label_values(labels_to_fetch, request.keyword)
        
        if results == "UNAUTHORIZED":
            raise HTTPException(status_code=401, detail="Токен авторизации протух.")

        for lbl_name, val in results.items():
            if "❌" in val or "⚠️" in val:
                resolved_links[lbl_name] = {"short": val, "full": "", "status": "error"}
            else:
                resolved_links[lbl_name] = {"short": val, "full": "", "status": "ok"}

    for name, data in resolved_links.items():
        if data["status"] == "ok":
            full_url = resolve_short_url(data["short"])
            data["full"] = full_url
            if "❌" in full_url or "⚠️" in full_url:
                data["status"] = "error"
                
    return {"status": "success", "resolved_links": resolved_links}