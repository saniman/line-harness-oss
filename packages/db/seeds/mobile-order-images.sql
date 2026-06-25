-- 飲食モバイルオーダーのサンプル料理写真（イラスト）。サンプル/PR 用途。
-- 画像は LIFF クライアントに同梱（apps/worker/public/menu/*.png → Pages 配信）。
-- image_url は Pages 同一オリジンの相対パス。実写真ができたら本物の URL に差し替える。冪等（id 指定）。

UPDATE menus SET image_url='/menu/food_sashimi.png'              WHERE id='seedmo-sashimi';
UPDATE menus SET image_url='/menu/food_pizza.png'                WHERE id='seedmo-margherita';
UPDATE menus SET image_url='/menu/drink_beer.png'                WHERE id='seedmo-beer';
UPDATE menus SET image_url='/menu/party_highball_jug.png'        WHERE id='seedmo-highball';
UPDATE menus SET image_url='/menu/drink_lemonade.png'            WHERE id='seedmo-sour';
UPDATE menus SET image_url='/menu/drink_uroncha_bottle.png'      WHERE id='seedmo-oolong';
UPDATE menus SET image_url='/menu/food_karaage_lemon.png'        WHERE id='seedmo-karaage';
UPDATE menus SET image_url='/menu/food_edamame.png'              WHERE id='seedmo-edamame';
UPDATE menus SET image_url='/menu/salad.png'                     WHERE id='seedmo-caesar';
UPDATE menus SET image_url='/menu/food_spaghetti_tarako.png'     WHERE id='seedmo-mentaiko';
UPDATE menus SET image_url='/menu/sweets_cup_ice_cream.png'      WHERE id='seedmo-icecream';
UPDATE menus SET image_url='/menu/sweets_fondant_au_chocolat.png' WHERE id='seedmo-gateau';
