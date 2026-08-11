UPDATE cfp_forms
SET published_json = json_set(published_json, '$.publishedStatus', status)
WHERE published_json IS NOT NULL;
