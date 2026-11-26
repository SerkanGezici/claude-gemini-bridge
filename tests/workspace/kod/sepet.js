// Alisveris sepeti — refactor edilebilir (var, ==, manuel dongu)
function toplamHesapla(urunler) {
  var toplam = 0;
  for (var i = 0; i < urunler.length; i++) {
    toplam = toplam + urunler[i].fiyat * urunler[i].adet;
  }
  return toplam;
}

function indirimUygula(toplam, kupon) {
  if (kupon == "INDIRIM10") {
    return toplam - toplam * 0.10;
  }
  if (kupon == "INDIRIM20") {
    return toplam - toplam * 0.20;
  }
  return toplam;
}

var sepet = [
  { ad: "Kalem", fiyat: 15, adet: 3 },
  { ad: "Defter", fiyat: 40, adet: 2 },
];
console.log("Toplam:", toplamHesapla(sepet));
