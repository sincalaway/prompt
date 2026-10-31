#!/usr/bin/env python3
"""Reclassify paired gallery records by topic, preserving image/prompt pairs."""
from __future__ import annotations
import collections
import glob
import hashlib
import json
import os
import re
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
DATA = BASE / 'data'
SHARDS = DATA / 'shards'

RULES = {
    '动态影像与分镜': [
        (r'\b(?:i2v|t2v|image[- ]to[- ]video|text[- ]to[- ]video)\b', 5),
        (r'\bvideo prompt\b|\bcreate\b.{0,80}\bvideo\b|\b\d{1,3}[- ]second\b.{0,70}\bvideo\b|\b\d{1,3}\s*seconds?\b.{0,70}\bvideo\b', 5),
        (r'\b(?:shot|scene)\s*\d+\b.{0,80}\b(?:camera|cut|video|film)\b|\bsequence of shots\b', 4),
        (r'\bstoryboard\b|分镜', 2),
        (r'视频提示词|生成.{0,12}视频|镜头切换|镜头运动|视频脚本|秒视频', 5),
    ],
    '信息图与科普可视化': [
        (r'\binfographic\b|\bdata visualization\b|\bscientific diagram\b|\btechnical diagram\b|\bcutaway educational\b', 5),
        (r'\bdiagram\b|\bblueprint\b|\banatomical\b|\bcross[- ]section\b|\bvisualiz(?:e|ing) (?:the )?(?:science|physics|history)\b', 3),
        (r'信息图|科普|剖面图|结构示意|图解|知识可视化|科学插图|解剖图|数据可视化', 5),
    ],
    '品牌与包装设计': [
        (r'\bbrand identity\b|\bbranding system\b|\bbrand system\b|\bbrand guidelines\b|\bpackaging design\b|\bbrand board\b|\blogo design\b', 5),
        (r'\blogo\b|\bpackaging\b|\bbrand(?: name| visual| concept| identity)?\b|\bproduct label\b|\bvisual identity\b', 2),
        (r'品牌视觉|品牌识别|品牌提案|品牌系统|品牌名|品牌设计|包装设计|包装提案|logo设计|标志设计', 5),
    ],
    '美食与饮品视觉': [
        (r'\bfood (?:photography|styling|commercial|advertisement|typography|poster|editorial)\b|\bculinary\b|\brecipe\b|\bfood art\b|\b(?:food|drink|beverage) (?:brand|product|campaign)\b', 5),
        (r'\bfood\b|\bdessert\b|\bcoffee\b|\btea\b|\bdrink\b|\bbeverage\b|\bnoodle\b|\bbento\b|\bcake\b|\bchocolate\b|\bice cream\b|\brestaurant menu\b', 3),
        (r'美食|食物|食品|饮品|咖啡|茶饮|甜点|蛋糕|冰淇淋|菜品|料理|食物字体|食品摄影|餐饮|饮料', 5),
    ],
    '东方美学与传统文化': [
        (r'\bhanfu\b|\bdunhuang\b|\btraditional chinese\b|\bchinese culture\b|\bchinese ink[- ]wash\b|\bchinese calligraphy\b|\beast asian heritage\b|\bchinese traditional art\b', 5),
        (r'\bqipao\b|\bkimono\b|\bgeisha\b|\bukiyo[- ]e\b|\bchinese opera\b|\btraditional asian\b|\boriental aesthetic\b|\bchinese mythology\b', 4),
        (r'东方美学|东方文化|东方文博|敦煌|汉服|古风|国风|中国风|中式|水墨|书法|传统工艺|文博|诗意留白|古典园林|龙凤|旗袍|和服|浮世绘|藏地|民族服饰|仙侠|古诗|古代风格', 5),
    ],
    '时尚与服饰设计': [
        (r'\bfashion editorial\b|\bfashion photography\b|\bclothing design\b|\bgarment design\b|\boutfit design\b|\bfashion lookbook\b|\bhaute couture\b|\brunway\b', 4),
        (r'\bfashion campaign\b|\bfashion\b|\bapparel\b|\bgarment\b|\boutfit\b|\bwardrobe\b|\bcostume\b|\bclothing\b|\buniform\b|\bdress\b|\bcouture\b|\bcosplay\b|\bwearable\b', 1.5),
        (r'时尚|服饰|服装|时装|穿搭|礼服|婚纱|制服|高定|服装设计|服饰设计|衣装|裙装|盔甲|四视图|服装展示|服装产品图', 3),
    ],
    '建筑与空间设计': [
        (r'\barchitecture\b|\barchitectural\b|\binterior design\b|\barchitectural photography\b|\bbuilding design\b|\barchitectural rendering\b|\bcityscape\b|\bskyline\b|\blandmark\b', 4),
        (r'\bbuilding\b|\binterior\b|\broom design\b|\bhouse design\b|\bmuseum\b|\btemple\b|\bskyscraper\b|\burban space\b|\bcity poster\b', 2),
        (r'建筑|地标|建筑设计|建筑空间|室内设计|空间设计|城市天际线|城市建筑|微型建筑|建筑海报', 4),
    ],
    '自然与风景': [
        (r'\blandscape\b|\bnature photography\b|\bscenic\b|\bmountain(?:s)?\b|\bforest\b|\bwaterfall\b|\bocean\b|\bseascape\b|\briver\b|\bdesert\b|\bglacier\b|\bflower field\b', 2),
        (r'自然风景|山水|山川|森林|海洋|海岸|瀑布|湖泊|草原|花海|风景插画|自然景观', 4),
    ],
    '动漫与角色设定': [
        (r'\banime\b|\bmanga\b|\bcharacter design\b|\bcharacter sheet\b|\bconcept art\b|\bgame character\b|\bcharacter turnaround\b|\bcomic character\b|\bvideo game character\b', 4),
        (r'动漫|二次元|漫画|角色设定|角色设计|人物设定|游戏角色|角色立绘|角色原画|人物概念设计', 5),
    ],
    '奇幻与科幻创作': [
        (r'\bfantasy\b|\bsci[- ]?fi\b|\bcyberpunk\b|\bfuturistic\b|\bsteampunk\b|\bspace opera\b|\balien\b|\bmythical creature\b|\bmagical\b|\bdystopian\b', 4),
        (r'奇幻|科幻|赛博朋克|未来科技|仙侠|玄幻|魔法|异世界|神话生物|外星|蒸汽朋克|暗黑幻想', 5),
    ],
    '拼贴与超现实创作': [
        (r'\bsurreal(?:ism|ist)?\b|\bcollage\b|\bphotomontage\b|\bdouble exposure\b|\bcomposite portrait\b|\bvisual illusion\b', 4),
        (r'拼贴|超现实|双重曝光|梦境拼接|影像合成|荒诞构图|错视|超现实主义', 5),
    ],
    '插画与绘本': [
        (r'\billustration\b|\billustrated\b|\bhand[- ]drawn\b|\bwatercolor\b|\bwatercolour\b|\bsketch\b|\bstorybook\b|\bpicture book\b|\bchildren.s book\b|\bline art\b|\bcolored pencil\b|\bwoodcut\b', 3),
        (r'插画|手绘|绘本|水彩|彩铅|儿童绘本|版画插画|线稿|卡通绘画|手绘海报', 5),
    ],
    '产品与静物视觉': [
        (r'\bproduct photography\b|\bproduct render(?:ing)?\b|\bproduct shot\b|\bpackshot\b|\bstill life photography\b|\bobject photography\b|\bisolated product\b|\bproduct design\b', 5),
        (r'产品渲染|产品摄影|产品展示|静物摄影|静物摆拍|商品主图|商品摄影|物品产品图', 5),
    ],
    '3D场景与微缩世界': [
        (r'\b3d diorama\b|\bisometric miniature\b|\bminiature world\b|\bminiature scene\b|\bminiature city\b|\b3d environment\b|\b3d scene\b|\bminiature model\b', 5),
        (r'\bvoxel\b|\bpaper craft model\b|\bscale model\b|\bisometric miniature\b|\bminiature world\b|\bminiature city\b|\bminiature scene\b', 3),
        (r'微缩场景|微缩世界|立体场景|微缩模型|等距微缩|三维空间场景', 5),
    ],
    '海报与字体设计': [
        (r'\btypography\b|\btypographic\b|\bposter design\b|\beditorial poster\b|\bmagazine cover\b|\bbook cover\b|\btitle design\b|\blettering\b|\bgraphic design\b|\bexperimental composition\b', 2),
        (r'\bposter\b|\bheadline\b|\bcover design\b|\blayout\b|\btitle\b|\btypeface\b|\bfont\b|\bvisual hierarchy\b|\bprint design\b|\beditorial design\b', 1),
        (r'海报|字体设计|巨字|文字排版|版式设计|封面设计|字体构图|印刷风格|文字构图|标题排版|构图实验|杂志封面', 3),
    ],
    '人物肖像与生活摄影': [
        (r'\bportrait photography\b|\bphotorealistic portrait\b|\bidentity lock\b|\bpreserve (?:my|her|his|the) (?:exact )?(?:face|identity)\b|\bselfie\b|\bheadshot\b|\bclose[- ]up portrait\b|\blifestyle portrait\b|\bfull[- ](?:body|length) (?:photograph|photo|portrait)\b|\b(?:photograph|photo) of a (?:young )?(?:woman|man|person)\b|\bstreet[- ]style portrait\b', 5),
        (r'\bportrait\b|\bwoman\b|\bman\b|\bgirl\b|\bboy\b|\bpeople photography\b|\bcandid photo\b|\bperson\b', 1),
        (r'人像摄影|肖像|自拍|生活写真|人物写真|面部特征|保留身份|人脸|真人摄影|人物摄影|全身照|街拍|人像写真', 5),
    ],
}

NEG = r"\b(?:avoid|avoiding|do not|don't|without|exclude|negative prompt|no)\b|不要|避免|不需要|排除|禁止|拒绝"
BOUND = r'[.!?。！？；;\n]'

def positive_hit(text: str, match: re.Match) -> bool:
    left = text[max(0, match.start() - 180):match.start()]
    negatives = list(re.finditer(NEG, left, re.I))
    return not negatives or not re.search(BOUND, left[negatives[-1].end():])

def score_text(text: str) -> dict[str, float]:
    scores = {category: 0.0 for category in RULES}
    for category, patterns in RULES.items():
        for pattern, weight in patterns:
            if any(positive_hit(text, match) for match in re.finditer(pattern, text, re.I)):
                scores[category] += weight
    return scores

def fallback(old: str) -> str:
    value = (old or '').lower()
    if any(x in value for x in ['食物', 'food']): return '美食与饮品视觉'
    if any(x in value for x in ['品牌', 'logo', '包装']): return '品牌与包装设计'
    if any(x in value for x in ['仙侠', '古风', '汉服', '东方', '敦煌', '藏地', '文博', '传统工艺', '古代', '和服', '旗袍']): return '东方美学与传统文化'
    if any(x in value for x in ['华丽服饰', '服饰', '服装', 'fashion', '时尚封面', '现代时装', 'jk制服', '婚纱', '工装', '礼服']): return '时尚与服饰设计'
    if any(x in value for x in ['建筑', 'landmark']): return '建筑与空间设计'
    if any(x in value for x in ['拼贴', '超现实', 'collage']): return '拼贴与超现实创作'
    if any(x in value for x in ['插画', '手绘']): return '插画与绘本'
    if any(x in value for x in ['赛博', '未来', '奇幻', '暗黑']): return '奇幻与科幻创作'
    if any(x in value for x in ['自然与风景', '风景']): return '自然与风景'
    if any(x in value for x in ['人物角色', '概念设定', '动漫', '和风']): return '动漫与角色设定'
    if any(x in value for x in ['海报', '字体', '构图', '印刷', '书籍封面']): return '海报与字体设计'
    if '电影感' in value: return '人物肖像与生活摄影'
    return '其他创意主题'

def looks_visual_prompt(text: str) -> bool:
    prompt_marker = bool(re.search(r'\bprompt\b|提示词|生成一张|请创作|请生成|画幅比例', text, re.I))
    visual_marker = bool(re.search(r'\b(?:image|photo|photograph|portrait|poster|illustration|scene|subject|camera|frame|composition|visual|render|aspect ratio|9:16|3:4|8k)\b|图片|画面|人像|肖像|海报|插画|场景|主体|构图|镜头|摄影|画幅', text, re.I))
    action_marker = bool(re.search(r'\b(?:create|generate|draw|render|design|illustrate|photograph|make)\b|生成|绘制|创作|设计|制作|拍摄', text, re.I))
    return (prompt_marker and visual_marker) or (action_marker and visual_marker)

def classify(record: dict) -> tuple[str, dict[str, float], str]:
    text = '\n'.join(p.get('text', '') for p in record.get('prompts', []) if isinstance(p, dict)).lower()
    hint = fallback(record.get('category', ''))
    raw = score_text(text)
    scores = dict(raw)
    if hint != '其他创意主题' and raw.get(hint, 0) > 0:
        scores[hint] += 0.75
    rank = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
    best, top = rank[0]
    hint_score = raw.get(hint, 0)
    runner_up = rank[1][1]
    if raw.get('动态影像与分镜', 0) >= 5:
        best = '动态影像与分镜'
    elif hint != '其他创意主题' and (looks_visual_prompt(text) or hint_score >= 2):
        best = best if top >= 5 and top - hint_score >= 2.5 and top - runner_up >= 1.5 else hint
    elif hint == '其他创意主题':
        best = best if top >= 4 and top - runner_up >= 1.5 else hint
    elif top >= 4 and top - runner_up >= 1.5:
        best = best
    else:
        best = '其他创意主题'
    return best, raw, text

def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main() -> None:
    manifest_path = DATA / 'manifest.json'
    original_manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    shard_paths = [DATA / item['file'] for item in original_manifest['shards']]
    original_images = {str(path.relative_to(BASE)): sha256(path) for path in (BASE / 'images').glob('*') if path.is_file()}
    original_count = 0
    category_counts: collections.Counter[str] = collections.Counter()
    category_shards: dict[str, set[str]] = collections.defaultdict(set)
    summaries: list[tuple[Path, list[dict], list[str]]] = []
    original_pairings: dict[str, str] = {}
    for path in shard_paths:
        records = json.loads(path.read_text(encoding='utf-8'))
        new_categories = []
        shard_id = path.stem.removeprefix('shard-')
        for record in records:
            original_count += 1
            pair_payload = json.dumps(
                {'image': record.get('image'), 'prompts': record.get('prompts'), 'negativePrompts': record.get('negativePrompts')},
                ensure_ascii=False, sort_keys=True, separators=(',', ':')
            ).encode('utf-8')
            original_pairings[str(record.get('image'))] = hashlib.sha256(pair_payload).hexdigest()
            new_category, _, _ = classify(record)
            new_categories.append(new_category)
            category_counts[new_category] += 1
            category_shards[new_category].add(shard_id)
        summaries.append((path, records, new_categories))
    if original_count != original_manifest['recordCount']:
        raise SystemExit(f"Record count mismatch before update: {original_count} != {original_manifest['recordCount']}")

    changed = 0
    for path, records, new_categories in summaries:
        for record, new_category in zip(records, new_categories):
            if record.get('category') != new_category or record.get('categories') != [new_category]:
                changed += 1
            record['category'] = new_category
            record['categories'] = [new_category]
        path.write_text(json.dumps(records, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')

    new_manifest = dict(original_manifest)
    new_manifest['categories'] = sorted(category_counts)
    new_manifest['categoryCounts'] = dict(sorted(category_counts.items()))
    new_manifest['categoryShards'] = {category: sorted(shards, key=int) for category, shards in sorted(category_shards.items())}
    manifest_path.write_text(json.dumps(new_manifest, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')

    # Verify all pairings and media files remained byte-identical; only category metadata can change.
    after_images = {str(path.relative_to(BASE)): sha256(path) for path in (BASE / 'images').glob('*') if path.is_file()}
    if original_images != after_images:
        raise SystemExit('Image files changed during topic update')
    check_count = 0
    after_pairings: dict[str, str] = {}
    for path in shard_paths:
        records = json.loads(path.read_text(encoding='utf-8'))
        check_count += len(records)
        for record in records:
            pair_payload = json.dumps(
                {'image': record.get('image'), 'prompts': record.get('prompts'), 'negativePrompts': record.get('negativePrompts')},
                ensure_ascii=False, sort_keys=True, separators=(',', ':')
            ).encode('utf-8')
            after_pairings[str(record.get('image'))] = hashlib.sha256(pair_payload).hexdigest()
    if check_count != original_manifest['recordCount']:
        raise SystemExit('Record count changed after topic update')
    if sum(category_counts.values()) != original_manifest['recordCount']:
        raise SystemExit('Topic counts do not add up to record count')
    if original_pairings != after_pairings:
        raise SystemExit('Image/prompt pairings changed during topic update')
    print(json.dumps({
        'records': check_count,
        'categories': len(category_counts),
        'changed_metadata_records': changed,
        'category_counts': dict(sorted(category_counts.items(), key=lambda item: (-item[1], item[0]))),
        'image_files_verified_unchanged': len(after_images),
        'pairings_verified_unchanged': len(after_pairings),
        'manifest_categories': len(new_manifest['categories']),
        'pairing_fields_written': ['category', 'categories'],
    }, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
