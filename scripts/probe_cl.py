"""Temporary: how CourtListener records the Oct. 19-20 written opinions (3 calls). Removed before merging."""
import json, os, sys, urllib.parse
sys.path.insert(0, "scripts")
import update
H = {"Authorization": f"Token {os.environ['COURTLISTENER_TOKEN']}"}
def get(path, params):
    url = "https://www.courtlistener.com/api/rest/v4/" + path + "?" + urllib.parse.urlencode(params)
    try:
        return json.loads(update.http_get(url, H))
    except Exception as e:
        print("ERROR", path, e); return {}
for case, doc in [("2:24-cv-01933", "378"), ("2:26-cv-01685", "9")]:
    d = get("recap-documents/", {"docket_entry__docket__court": "laed", "docket_entry__docket__docket_number": case, "document_number": doc,
                                "fields": "id,is_free_on_pacer,date_created,date_modified,is_available,description"})
    for r in d.get("results", []):
        print(case, doc, json.dumps(r)[:400])
d = get("recap-documents/", {"is_free_on_pacer": "true", "docket_entry__docket__court": "laed", "date_modified__gte": "2026-10-19T00:00:00-05:00",
                             "order_by": "date_modified", "fields": "id,document_number,date_created,date_modified,absolute_url"})
print("free docs modified since Oct 19:", d.get("count"))
for r in d.get("results", [])[:20]:
    print("  ", r.get("document_number"), r.get("date_created"), r.get("date_modified"), r.get("absolute_url"))
