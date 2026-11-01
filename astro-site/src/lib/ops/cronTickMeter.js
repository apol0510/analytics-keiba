/**
 * cron-tick の Airtable 呼び出しを `cron-tick` として数える。
 * ⚠️ cron-tick.js の**最初の import** にする（まとめた各処理も import 時に meter を入れようとするが、
 *    同じプロセスでは最初の 1 回だけが効く。順番を変えると別の処理名で数えられる）。
 */
import { installAirtableCallMeter } from './airtableCallMeter.js';

installAirtableCallMeter({ source: 'cron-tick' });
