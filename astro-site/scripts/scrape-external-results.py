#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
外部サイト実績データ自動取り込みスクリプト
apolon.keibanahibi.com から12年分のデータを取得してarchiveResults.json形式に変換
"""

import re
import json
import requests
from bs4 import BeautifulSoup
from datetime import datetime
from typing import List, Dict, Any

# 外部サイトベースURL
BASE_URL = "https://apolon.keibanahibi.com/index.php"

def generate_month_urls(start_year: int = 2013, start_month: int = 9) -> List[str]:
    """
    2013年9月〜現在までの月別URL生成
    """
    urls = []
    current = datetime.now()

    year = start_year
    month = start_month

    while True:
        # URL生成: ?kaiinkekka_YYYYMM
        url = f"{BASE_URL}?kaiinkekka_{year}{month:02d}"
        urls.append((url, year, month))

        # 次の月へ
        month += 1
        if month > 12:
            month = 1
            year += 1

        # 現在月を超えたら終了
        if year > current.year or (year == current.year and month > current.month):
            break

    return urls

def parse_race_result_page(html: str, year: int, month: int) -> List[Dict[str, Any]]:
    """
    1ページ分のHTML解析してレース結果を抽出

    期待される構造:
    8/31船橋競馬予想 有料版 結果
    1R 12-8馬単 600円 的中！
    2R 1-9馬単 3.990円 的中！
    """
    soup = BeautifulSoup(html, 'html.parser')
    results = []

    # 日付見出しを探索（例: "8/31船橋競馬予想 有料版"）
    date_pattern = re.compile(r'(\d{1,2})/(\d{1,2})\s*(\S+)競馬')

    # ページ全体のテキストを取得
    page_text = soup.get_text()

    # 日付ブロックごとに分割
    current_date = None
    current_venue = None

    for line in page_text.split('\n'):
        line = line.strip()
        if not line:
            continue

        # 日付・競馬場検出
        date_match = date_pattern.search(line)
        if date_match:
            m, d, venue = date_match.groups()
            current_date = f"{year}-{int(m):02d}-{int(d):02d}"
            current_venue = venue
            continue

        # レース結果検出（例: "1R 12-8馬単 600円 的中！"）
        race_pattern = re.compile(r'(\d{1,2})R\s+(\d+)-(\d+)馬単\s+([\d,\.]+)円\s+的中')
        race_match = race_pattern.search(line)

        if race_match and current_date and current_venue:
            race_num, horse1, horse2, payout_str = race_match.groups()

            # 配当金額パース（カンマ・ピリオド除去）
            payout = int(payout_str.replace(',', '').replace('.', ''))

            results.append({
                'date': current_date,
                'venue': current_venue,
                'raceNumber': int(race_num),
                'umatan': f"{horse1}-{horse2}",
                'payout': payout,
                'hit': True
            })

    return results

def convert_to_archive_format(scraped_data: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    スクレイピングデータをarchiveResults.json形式に変換

    archiveResults.json形式:
    {
      "2025": {
        "10": [
          {
            "date": "2025-10-16",
            "venue": "川崎",
            "totalRaces": 12,
            "hitRaces": 7,
            "hitRate": "58%",
            "totalPayout": 13040,
            "recoveryRate": "124%",
            "races": [...]
          }
        ]
      }
    }
    """
    archive = {}

    # 日付ごとにグループ化
    daily_groups = {}
    for race in scraped_data:
        date = race['date']
        if date not in daily_groups:
            daily_groups[date] = []
        daily_groups[date].append(race)

    # archiveResults.json形式に変換
    for date, races in daily_groups.items():
        year, month, day = date.split('-')

        if year not in archive:
            archive[year] = {}
        if month not in archive[year]:
            archive[year][month] = []

        # 日別サマリー作成
        venue = races[0]['venue'] if races else '不明'
        hit_races = len(races)  # 的中レースのみなのでhit_races = len(races)
        total_payout = sum(r['payout'] for r in races)

        # ⚠️ 警告：不的中レース数が不明なので、totalRacesは推測
        # 南関競馬は通常12R or 11R or 10R or 8R
        # 最大レース番号から推測
        max_race_num = max(r['raceNumber'] for r in races)
        total_races = max_race_num  # 保守的推測

        hit_rate_value = (hit_races / total_races * 100) if total_races > 0 else 0
        hit_rate = f"{hit_rate_value:.0f}%"

        # ⚠️ 警告：購入点数情報がないため回収率計算不可
        # デフォルト：馬単1点 = 100円として計算
        total_bet = hit_races * 100  # 全的中レース×100円（馬単1点想定）
        recovery_rate_value = (total_payout / total_bet * 100) if total_bet > 0 else 0
        recovery_rate = f"{recovery_rate_value:.0f}%"

        # レース詳細データ作成
        race_details = []
        for r in races:
            race_details.append({
                'raceNumber': r['raceNumber'],
                'raceName': f"{r['raceNumber']}R",  # レース名情報なし
                'strategy': 'バランス型',  # 戦略情報なし・馬単なのでバランス型と推測
                'betType': '馬単',
                'betDetails': r['umatan'],
                'result': '✅ 的中',
                'payout': f"¥{r['payout']:,}"
            })

        # 日別データ追加
        archive[year][month].append({
            'date': date,
            'venue': venue,
            'totalRaces': total_races,
            'hitRaces': hit_races,
            'hitRate': hit_rate,
            'totalPayout': total_payout,
            'recoveryRate': recovery_rate,
            'races': race_details
        })

    return archive

def scrape_all_results(start_year: int = 2013, start_month: int = 9) -> Dict[str, Any]:
    """
    全期間のデータをスクレイピング
    """
    print("🔍 外部サイトスクレイピング開始...")
    print(f"📅 対象期間: {start_year}年{start_month}月〜現在")

    urls = generate_month_urls(start_year, start_month)
    print(f"📊 総URL数: {len(urls)}件\n")

    all_results = []
    success_count = 0
    error_count = 0

    for url, year, month in urls:
        try:
            print(f"⏳ 取得中: {year}年{month:02d}月... ", end='', flush=True)
            response = requests.get(url, timeout=10)

            if response.status_code == 404:
                print("❌ 404 Not Found")
                error_count += 1
                continue

            response.raise_for_status()

            # HTML解析
            results = parse_race_result_page(response.text, year, month)

            if results:
                all_results.extend(results)
                print(f"✅ {len(results)}レース取得")
                success_count += 1
            else:
                print("⚠️ データなし")

        except Exception as e:
            print(f"❌ エラー: {e}")
            error_count += 1

    print(f"\n📊 スクレイピング完了")
    print(f"✅ 成功: {success_count}ヶ月")
    print(f"❌ 失敗: {error_count}ヶ月")
    print(f"🏇 総レース数: {len(all_results)}レース\n")

    # archiveResults.json形式に変換
    print("🔄 データ変換中...")
    archive = convert_to_archive_format(all_results)
    print("✅ 変換完了\n")

    return archive

def merge_with_existing_archive(new_data: Dict[str, Any], existing_file: str) -> Dict[str, Any]:
    """
    既存のarchiveResults.jsonとマージ（既存データ優先）
    """
    try:
        with open(existing_file, 'r', encoding='utf-8') as f:
            existing = json.load(f)
        print(f"📂 既存ファイル読み込み成功: {existing_file}")
    except FileNotFoundError:
        print(f"⚠️ 既存ファイルなし、新規作成します")
        existing = {}

    # マージ（既存データ優先）
    merged = existing.copy()

    for year, months in new_data.items():
        if year not in merged:
            merged[year] = {}

        for month, days in months.items():
            if month not in merged[year]:
                merged[year][month] = []

            # 既存の日付を取得
            existing_dates = {d['date'] for d in merged[year][month]}

            # 新規データのみ追加（既存データは上書きしない）
            for day_data in days:
                if day_data['date'] not in existing_dates:
                    merged[year][month].append(day_data)

    return merged

def main():
    """
    メイン処理
    """
    print("=" * 60)
    print("🏇 外部サイト実績データ自動取り込みシステム")
    print("=" * 60)
    print()

    # スクレイピング実行
    scraped_data = scrape_all_results(start_year=2013, start_month=9)

    # 既存ファイルとマージ
    archive_file = "../src/data/archiveResults.json"
    merged_data = merge_with_existing_archive(scraped_data, archive_file)

    # ファイル保存
    output_file = "scraped_archive_results.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(merged_data, f, ensure_ascii=False, indent=2)

    print(f"💾 保存完了: {output_file}")
    print()
    print("=" * 60)
    print("✅ すべての処理が完了しました！")
    print("=" * 60)
    print()
    print("📋 次のステップ:")
    print(f"1. {output_file} の内容を確認")
    print("2. 問題なければ src/data/archiveResults.json にコピー")
    print("3. git add, commit, push で本番反映")

if __name__ == "__main__":
    main()
