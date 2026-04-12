/**
 * アコーディオン機能の共通化モジュール
 * 重複したtoggle関数を統一管理
 */

/**
 * 汎用アコーディオントグル関数
 * @param {string} raceId - レースID（例: 'race-11r'）
 * @param {string} iconId - アイコンID（例: 'toggle-11r'）
 */
export function toggleAccordion(raceId, iconId) {
    const content = document.getElementById(raceId);
    const icon = document.getElementById(iconId);
    
    if (!content) {
        console.warn(`Element not found: ${raceId}`);
        return;
    }
    
    if (content.classList.contains('active')) {
        content.classList.remove('active');
        content.style.maxHeight = '0';
        if (icon) {
            icon.style.transform = 'rotate(0deg)';
        }
    } else {
        content.classList.add('active');
        content.style.maxHeight = content.scrollHeight + 'px';
        if (icon) {
            icon.style.transform = 'rotate(180deg)';
        }
    }
}

/**
 * レース番号からトグル関数を生成
 * @param {number} raceNumber - レース番号（1-12）
 * @returns {Function} トグル関数
 */
export function createRaceToggle(raceNumber) {
    return function() {
        const raceId = `race-${raceNumber}r`;
        const iconId = `toggle-${raceNumber}r`;
        toggleAccordion(raceId, iconId);
    };
}

/**
 * すべてのレースアコーディオンを初期化
 * @param {number} totalRaces - 総レース数（デフォルト: 12）
 */
export function initializeRaceAccordions(totalRaces = 12) {
    // グローバルスコープに関数を登録
    for (let i = 1; i <= totalRaces; i++) {
        window[`toggleRace${i}R`] = createRaceToggle(i);
    }
}

/**
 * データ属性を使った自動アコーディオン設定
 * data-accordion-trigger と data-accordion-content を持つ要素を自動的に連携
 */
export function setupAutoAccordions() {
    document.querySelectorAll('[data-accordion-trigger]').forEach(trigger => {
        const targetId = trigger.dataset.accordionTrigger;
        const iconId = trigger.dataset.accordionIcon;
        
        trigger.addEventListener('click', () => {
            toggleAccordion(targetId, iconId);
        });
    });
}

/**
 * アコーディオングループの管理（一つ開くと他が閉じる）
 * @param {string} groupClass - グループのクラス名
 */
export function setupAccordionGroup(groupClass) {
    const accordions = document.querySelectorAll(`.${groupClass}`);
    
    accordions.forEach(accordion => {
        accordion.addEventListener('click', function() {
            const isActive = this.classList.contains('active');
            
            // すべて閉じる
            accordions.forEach(acc => {
                const contentId = acc.dataset.accordionTrigger;
                const iconId = acc.dataset.accordionIcon;
                const content = document.getElementById(contentId);
                const icon = document.getElementById(iconId);
                
                if (content) {
                    content.classList.remove('active');
                    content.style.maxHeight = '0';
                }
                if (icon) {
                    icon.style.transform = 'rotate(0deg)';
                }
                acc.classList.remove('active');
            });
            
            // クリックされたものを開く（既に開いていた場合は閉じたまま）
            if (!isActive) {
                const targetId = this.dataset.accordionTrigger;
                const iconId = this.dataset.accordionIcon;
                toggleAccordion(targetId, iconId);
                this.classList.add('active');
            }
        });
    });
}

/**
 * アコーディオンの状態を取得
 * @param {string} raceId - レースID
 * @returns {boolean} 開いているかどうか
 */
export function isAccordionOpen(raceId) {
    const content = document.getElementById(raceId);
    return content ? content.classList.contains('active') : false;
}

/**
 * すべてのアコーディオンを開く/閉じる
 * @param {boolean} open - true: 開く, false: 閉じる
 * @param {string} prefix - IDのプレフィックス（デフォルト: 'race-'）
 */
export function toggleAllAccordions(open, prefix = 'race-') {
    for (let i = 1; i <= 12; i++) {
        const raceId = `${prefix}${i}r`;
        const iconId = `toggle-${i}r`;
        const content = document.getElementById(raceId);
        const icon = document.getElementById(iconId);
        
        if (content) {
            if (open) {
                content.classList.add('active');
                content.style.maxHeight = content.scrollHeight + 'px';
                if (icon) icon.style.transform = 'rotate(180deg)';
            } else {
                content.classList.remove('active');
                content.style.maxHeight = '0';
                if (icon) icon.style.transform = 'rotate(0deg)';
            }
        }
    }
}

/**
 * アニメーション付きアコーディオントグル
 * @param {string} raceId - レースID
 * @param {string} iconId - アイコンID
 * @param {number} duration - アニメーション時間（ミリ秒）
 */
export function toggleAccordionAnimated(raceId, iconId, duration = 300) {
    const content = document.getElementById(raceId);
    const icon = document.getElementById(iconId);
    
    if (!content) return;
    
    // トランジションを設定
    content.style.transition = `max-height ${duration}ms ease-in-out`;
    if (icon) {
        icon.style.transition = `transform ${duration}ms ease-in-out`;
    }
    
    // トグル実行
    toggleAccordion(raceId, iconId);
    
    // トランジション後にリセット（パフォーマンス向上）
    setTimeout(() => {
        if (content) content.style.transition = '';
        if (icon) icon.style.transition = '';
    }, duration);
}

/**
 * URLハッシュに基づいて特定のアコーディオンを開く
 * 例: #race-11r があれば11Rを自動的に開く
 */
export function openAccordionFromHash() {
    const hash = window.location.hash.slice(1); // #を除去
    if (hash && hash.startsWith('race-')) {
        const raceNumber = hash.match(/race-(\d+)r/);
        if (raceNumber && raceNumber[1]) {
            const toggle = window[`toggleRace${raceNumber[1]}R`];
            if (toggle) {
                setTimeout(toggle, 100); // ページ読み込み後に実行
            }
        }
    }
}

// デフォルトエクスポート：最も使用頻度の高い関数
export default {
    toggleAccordion,
    initializeRaceAccordions,
    setupAutoAccordions
};