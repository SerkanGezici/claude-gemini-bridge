#!/usr/bin/env python3
"""Basit istatistik araclari (icinde KASITLI hatalar var)."""


def ortalama(sayilar):
    toplam = 0
    for s in sayilar:
        toplam += s
    # BUG: her zaman 3'e boluyor, gercek eleman sayisina degil
    return toplam / 3


def en_buyuk(sayilar):
    enb = 0  # BUG: negatif sayilarda yanlis (0 ile basliyor)
    for s in sayilar:
        if s > enb:
            enb = s
    return enb


def bol(a, b):
    return a / b  # BUG: b=0 kontrolu yok


if __name__ == "__main__":
    veri = [10, 20, 30, 40]
    print("Ortalama:", ortalama(veri))   # dogru: 25.0
    print("En buyuk:", en_buyuk(veri))   # dogru: 40
