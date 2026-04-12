#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import re

def fix_all_star_ratings():
    """全ての適性評価を正しく星評価に修正"""
    
    with open('src/data/allRacesPrediction.json', 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    total_updates = 0
    
    for race_key, race_data in data.items():
        if race_key.startswith('race'):
            print(f"\n{race_key}を処理中...")
            
            # 各馬を処理
            for category in ['main', 'sub', 'sub1', 'sub2']:
                if category in race_data['horses']:
                    horses = race_data['horses'][category]
                    
                    for horse in horses:
                        # 現在の適性評価をチェック
                        for feature_key in horse.get('features', {}):
                            feature = horse['features'][feature_key]
                            
                            # 「適性評価: B級」を探してる
                            if '適性評価: B級' in feature:
                                total_updates += 1
                                
                                # 本命と対抗のみ星評価に変更
                                if category in ['main', 'sub']:
                                    # 93pt なので95pt以下 → ⭐⭐⭐
                                    new_feature = feature.replace('適性評価: B級', '総合適性: ⭐⭐⭐')
                                    horse['features'][feature_key] = new_feature
                                    print(f"  {category} {horse.get('name', 'Unknown')}: 適性評価: B級 → 総合適性: ⭐⭐⭐")
                                else:
                                    # 単穴以下はB級のまま維持
                                    print(f"  {category} {horse.get('name', 'Unknown')}: B級のまま維持")
    
    print(f"\n合計更新数: {total_updates}")
    
    # ファイルに保存
    with open('src/data/allRacesPrediction.json', 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    
    print("✅ 全ての適性評価を正しく修正しました！")

if __name__ == "__main__":
    fix_all_star_ratings()