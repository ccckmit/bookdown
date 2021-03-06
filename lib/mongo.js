var MD = require("./markdown");
var io = require("./io");
// var File = U.File;
var mongodb = require('mongodb');
var path = require("path");
var M = module.exports = {}

/* 
注意： MongoDB 3.2 版之後可以支援中文全文檢索了，但目前我們還是使用下列方法。

MongoDB 只支援《英文和數字的全文檢索》，但是不能正確進行《中文全文檢索》。
於是我將所有非英文 unicode 字元通通轉成其 unicode 16進位數字碼，放入 keywords 欄位中，這樣就可以先將查詢的中文轉成數字碼後，再進行檢索 ...
這種方法讓 mongoDB 也能支援《中文的全文檢索》了！

範例：
文章：.... 我是陳鍾誠 .... => ... 6211 662f 9673 937e 8aa0 ...
檢索：包含《誠》字的文章 => mdTable.find({"$text":{"$search":getKeywords("誠")}}).toArray();

但這種方法可能會誤撞，說明如下：

對於多個中文字形成的詞彙，像是《皮卡丘》，如果沒有把完整的詞碼也儲存，可能會撞到《他的皮卡在山丘上》這句或，導致誤撞，還需要進一步過濾！
*/
// http://stackoverflow.com/questions/5827612/node-js-fs-readdir-recursive-directory-search

M.open = function*(dbName, setting) {
  return yield mongodb.MongoClient.connect("mongodb://"+setting.user+":"+setting.password+"@127.0.0.1:"+setting.port+"/"+dbName);
}

M.close = function*(db) {
  yield db.close();
}

M.saveText = function*(docTable, text, filePath) {
  var type = path.extname(filePath).substring(1);
  var file = { path:filePath, text:text, type:type };
  file.keywords = M.getKeywords(text);
//  console.log("saveText:file=%j", file);
  var result = yield docTable.updateOne({ path:filePath, type:file.type }, file, {upsert:true});
}

M.saveMd = function*(docTable, md, filePath) {
  console.log("saveMd:filePath=%s", filePath);
  yield docTable.remove({path:filePath});
  yield M.saveText(docTable, md, filePath);
/*
  var file = { path:filePath, md:md, type:"md" };
  file.keywords = M.getKeywords(file.md);
  var result = yield docTable.updateOne({ path:filePath, type:file.type }, file, {upsert:true});
*/  
  var parts = MD.parse(md).parts;
  for (var pi=0; pi<parts.length; pi++) {
    var part = parts[pi];
    part.path = filePath;
    part.keywords = M.getKeywords(part.text);
    var result = yield docTable.updateOne({path:part.path, type:part.type, part:pi}, part, {upsert:true});
//    console.log("update result=%j", result);
    var table = MD.parse(part.text).jsons;
    for (var ti = 0; ti<table.length; ti++) {
      yield M.saveJson(docTable, table[ti], filePath, pi, ti);
    }
  }
}

M.saveJson = function*(docTable, json, filePath, part=0, row=0) {
  var obj  = {json:json, path:filePath, type:"json", part:part, row:row};
//  var m = JSON.stringify(json).match(/(\-?\d+)[^\.]/);
//  if (m) json.integer = parseInt(m[1]);
  obj.keywords = M.getKeywords(JSON.stringify(obj));
  yield docTable.updateOne({path:obj.path, part:obj.part, row:obj.row}, obj, {upsert:true});
}

M.importFiles = function*(docTable, dir, fileList) {
  var dir = (dir.endsWith("/"))?dir:dir+"/";
  for (var i=0; i<fileList.length; i++) {
    try {
      var filePath = fileList[i];
      console.log("filePath=%s", filePath);
      if (filePath.endsWith(".md")) {
        var md = yield io.readFile(dir+filePath);
        yield M.saveMd(docTable, md, filePath);
      } else if (filePath.endsWith(".mdo")) {
        var mdo = yield io.readFile(dir+filePath);
        var json = MD.parseMdo(mdo);
        yield M.saveJson(docTable, json, filePath, 0, 0);
      } else if (filePath.endsWith(".json")) {
        var json = yield io.readJson(dir+filePath);
        yield M.saveJson(docTable, json, filePath, 0, 0);
      }
    } catch (err) {
      console.log(err.name + ': ' + err.message);
      console.log(err.stack)
    }
  }
  yield docTable.ensureIndex({"$**":"text"}, {name:"docTextIndex"})
  yield docTable.ensureIndex({type: 1, path:1, hash:1 });
}

M.query = function*(docTable, q) {
  return yield docTable.find(q).toArray();
}

// ref: https://docs.mongodb.com/manual/reference/operator/query/text/
M.search = function*(docTable, keywords, q={}) {
//  console.log("keywords=%s", keywords);
  var k = M.getKeywords(keywords);
  var e = M.getEnglishWords(keywords);
  var ke = (e+" "+k).trim();
  var query = (ke==="")?q:{$and:[{$text:{$search:ke, $caseSensitive:false}}, q]};
//  console.log("query=%j", query);
  var results = yield docTable.find(query).toArray();
  
  var keyList = keywords.toLowerCase().split(/\s+/);
  return results.filter(function(doc) {
    var json = JSON.stringify(doc).toLowerCase();
    return keyList.every(function(key) {
      return json.indexOf(key)>=0
    })
  })
}

M.charToUnicode = function(c) {
  return c.toString(16);
}

M.unicodeToChar = function(code) {
  return String.fromCodePoint(parseInt(code, 16));
}

M.getEnglishWords = function(text) {
  var m = text.match(/\w+/gi);
  return (m)?m.join(' '):'';
}

M.getKeywords = function(text) {
  var keywords = new Set();
  for (var i=0; i<text.length; i++) {
    var c = text.charCodeAt(i);
    if (c>=256) { // not ASCII (English)
      keywords.add(M.charToUnicode(c));
    }
  }
  return Array.from(keywords).join(" ");
}

M.decodeKeywords=function(keywords) {
  var keys = keywords.split(" ");
  var decode=[];
  for (var i=0; i<keys.length; i++) {
    var c = M.unicodeToChar(keys[i]);
    decode[i] = c;
  }
  return decode.join('');
}

/*
M.saveMd = function*(docTable, md, filePath) {
  var parts = MD.parse(md).parts;
  yield docTable.remove({path:filePath});
  for (var pi=0; pi<parts.length; pi++) {
    var part = parts[pi];
    part.path = filePath;
    part.keywords = M.getKeywords(part.md);
    var result = yield docTable.updateOne({path:part.path,part:pi}, part, {upsert:true});
//    console.log("update result=%j", result);
    var table = MD.parse(part.md).jsons;
    for (var ti = 0; ti<table.length; ti++) {
      yield M.saveJson(docTable, table[ti], filePath, pi, ti);
    }
  }
}
*/
