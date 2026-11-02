import { tx, pool } from "../server/db.js";
import { initializeStore } from "../server/store-initial.js";
if (!process.argv.includes("--confirm-new-store")) {
  console.error("Нужно явное --confirm-new-store. Существующие настройки изменяйте в админке.");
  process.exitCode=1;
} else {
  tx(initializeStore).then(()=>console.log("Начальные сведения подготовлены. Оформления и перевозчики выключены; документы — черновики, телефон — тестовый.")).catch(()=>{console.error("Инициализация не выполнена: проверьте, что база новая и миграции применены.");process.exitCode=1;}).finally(()=>pool.end());
}
