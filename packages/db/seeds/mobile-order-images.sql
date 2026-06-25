-- 飲食モバイルオーダーのサンプル料理写真（LoremFlickr）。サンプル/PR 用途。
-- 各メニューの内容に合うキーワードを指定。?lock=N で画像を固定し、毎回変わらないようにする。
-- 実写真ができたら image_url を本物の URL に差し替える。冪等（id 指定 UPDATE）。

UPDATE menus SET image_url='https://loremflickr.com/320/240/sashimi?lock=11'         WHERE id='seedmo-sashimi';
UPDATE menus SET image_url='https://loremflickr.com/320/240/pizza?lock=12'           WHERE id='seedmo-margherita';
UPDATE menus SET image_url='https://loremflickr.com/320/240/beer?lock=13'            WHERE id='seedmo-beer';
UPDATE menus SET image_url='https://loremflickr.com/320/240/whiskey?lock=14'         WHERE id='seedmo-highball';
UPDATE menus SET image_url='https://loremflickr.com/320/240/cocktail?lock=15'        WHERE id='seedmo-sour';
UPDATE menus SET image_url='https://loremflickr.com/320/240/tea?lock=16'             WHERE id='seedmo-oolong';
UPDATE menus SET image_url='https://loremflickr.com/320/240/friedchicken?lock=17'    WHERE id='seedmo-karaage';
UPDATE menus SET image_url='https://loremflickr.com/320/240/edamame?lock=18'         WHERE id='seedmo-edamame';
UPDATE menus SET image_url='https://loremflickr.com/320/240/salad?lock=19'           WHERE id='seedmo-caesar';
UPDATE menus SET image_url='https://loremflickr.com/320/240/pasta?lock=20'           WHERE id='seedmo-mentaiko';
UPDATE menus SET image_url='https://loremflickr.com/320/240/icecream?lock=21'        WHERE id='seedmo-icecream';
UPDATE menus SET image_url='https://loremflickr.com/320/240/chocolate,cake?lock=22'  WHERE id='seedmo-gateau';
