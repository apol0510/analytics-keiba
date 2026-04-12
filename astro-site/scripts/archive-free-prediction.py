#!/usr/bin/env python3
"""
無料予想の日別アーカイブ自動保存スクリプト
Usage: python3 scripts/archive-free-prediction.py
"""

import json
import shutil
from pathlib import Path
from datetime import datetime

def archive_free_prediction():
    """allRacesPrediction.jsonを日別ファイルとして保存"""

    # ファイルパス
    base_dir = Path(__file__).parent.parent
    source_file = base_dir / 'src/data/allRacesPrediction.json'

    # allRacesPrediction.json を読み込み
    try:
        with open(source_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        print('❌ エラー: allRacesPrediction.json が見つかりません')
        return False
    except json.JSONDecodeError:
        print('❌ エラー: allRacesPrediction.json のJSON形式が不正です')
        return False

    # レース日付を取得
    race_date = data.get('raceDate')
    if not race_date:
        print('❌ エラー: raceDate が見つかりません')
        return False

    # 日付形式チェック (YYYY-MM-DD)
    try:
        datetime.strptime(race_date, '%Y-%m-%d')
    except ValueError:
        print(f'❌ エラー: 日付形式が不正です ({race_date})')
        return False

    # 保存先パス
    archive_dir_src = base_dir / 'src/data/free-predictions'
    archive_dir_public = base_dir / 'public/data/free-predictions'

    # ディレクトリ作成
    archive_dir_src.mkdir(parents=True, exist_ok=True)
    archive_dir_public.mkdir(parents=True, exist_ok=True)

    # ファイル名: YYYY-MM-DD.json
    archive_file_src = archive_dir_src / f'{race_date}.json'
    archive_file_public = archive_dir_public / f'{race_date}.json'

    # 既存ファイルチェック
    if archive_file_src.exists():
        print(f'⚠️  警告: {race_date}.json は既に存在します（上書き）')

    # src/data/free-predictions/ に保存
    try:
        with open(archive_file_src, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f'✅ src/data/free-predictions/{race_date}.json に保存しました')
    except Exception as e:
        print(f'❌ エラー: src/data への保存に失敗しました - {e}')
        return False

    # public/data/free-predictions/ にコピー
    try:
        shutil.copy2(archive_file_src, archive_file_public)
        print(f'✅ public/data/free-predictions/{race_date}.json に同期しました')
    except Exception as e:
        print(f'❌ エラー: public/data への同期に失敗しました - {e}')
        return False

    # レース情報表示
    track = data.get('track', '不明')
    total_races = data.get('totalRaces', 0)
    print(f'\n📊 アーカイブ情報:')
    print(f'  レース日: {race_date}')
    print(f'  会場: {track}')
    print(f'  レース数: {total_races}R')

    return True

if __name__ == '__main__':
    print('🏇 無料予想アーカイブ処理開始...\n')

    success = archive_free_prediction()

    if success:
        print('\n✨ アーカイブ処理が完了しました')
    else:
        print('\n❌ アーカイブ処理に失敗しました')
        exit(1)
