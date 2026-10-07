import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Table, Button, Modal, Form, Input, Select, Tag, Space, Popconfirm,
  message, Card, Avatar,
} from 'antd';
import { PlusOutlined, KeyOutlined, DeleteOutlined, UserOutlined, EditOutlined, AimOutlined } from '@ant-design/icons';
import { api } from '../services/apiClient';
import { useKullanici } from '../context/useKullanici';
import { useFirma } from '../context/useFirma';
import type { Kullanici, KullaniciRol } from '../types/kullanici';
import { formatAdSoyad, formatUnvan } from '../utils/formatters';
import { gorselToYuzOdakliVesikalik, yuzModeliniArkaPlandaIsit } from '../utils/yuzTespit';
import {
  isYonetici,
  tumFirmalaraErisir as tumFirmalaraErisirFn,
} from '../utils/yetkiUtils';
import { useSayfaRehberi } from '../hooks/useSayfaRehberi';
import { PERSONEL_TIPLERI } from './PersonelSayfasi.tips';

interface FormValues {
  kullaniciAdi: string;
  adSoyad: string;
  unvan: string;
  rol: KullaniciRol;
  firmaId?: string;
  gosterilenFirmalar?: string[];
  telefon?: string;
  dahili?: string;
}

export default function PersonelSayfasi() {
  useSayfaRehberi(PERSONEL_TIPLERI, { sayfaAdi: 'Personel' });
  const { aktifKullanici } = useKullanici();
  const { firmalar } = useFirma();
  const [liste, setListe] = useState<Kullanici[]>([]);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [duzenlenen, setDuzenlenen] = useState<Kullanici | null>(null);
  const [form] = Form.useForm<FormValues>();

  // firma_admin'in uygulama içi yetkileri super_admin ile eşit. Yalnızca
  // super_admin hesaplarının yönetimi (düzenle/sil/şifre sıfırla) ve süper
  // yönetici rolünde personel oluşturma istisnadır — onlar inline
  // aktifKullanici?.rol === 'super_admin' kontrolü ile korunur.
  const isAdmin = isYonetici(aktifKullanici?.rol);
  const tumFirmalaraErisir = tumFirmalaraErisirFn(aktifKullanici?.rol);

  // Toplu yüz odaklı profil foto işleme
  const [topluIsleniyor, setTopluIsleniyor] = useState(false);
  const [topluIlerleme, setTopluIlerleme] = useState<{ tamam: number; toplam: number } | null>(null);

  // Sayfa açılınca yüz modelini arka planda ısıt (admin toplu işleme için hazır)
  useEffect(() => { if (isAdmin) yuzModeliniArkaPlandaIsit(); }, [isAdmin]);

  async function tumFotograflariYenidenIsle() {
    if (!aktifKullanici) return;
    const hedefler = liste.filter((k) => {
      if (!k.profilFotoUrl) return false;
      // firma_admin sadece kendi firması, super_admin herkes
      if (aktifKullanici.rol === 'super_admin') return true;
      return k.firmaId === aktifKullanici.firmaId;
    });
    if (hedefler.length === 0) {
      message.info('Profil fotoğrafı olan kullanıcı bulunamadı.');
      return;
    }

    setTopluIsleniyor(true);
    setTopluIlerleme({ tamam: 0, toplam: hedefler.length });

    let basarili = 0;
    let basarisiz = 0;
    for (let i = 0; i < hedefler.length; i += 1) {
      const k = hedefler[i];
      try {
        if (!k.profilFotoUrl) continue;
        const yeni = await gorselToYuzOdakliVesikalik(k.profilFotoUrl);
        await api.auth.uploadPhotoForUser(k.id, yeni);
        basarili += 1;
      } catch (err) {
        console.warn(`[tumFotograflariYenidenIsle] ${k.kullaniciAdi} hata:`, err);
        basarisiz += 1;
      }
      setTopluIlerleme({ tamam: i + 1, toplam: hedefler.length });
    }

    setTopluIsleniyor(false);
    setTopluIlerleme(null);
    if (basarisiz === 0) {
      message.success(`Tüm ${basarili} profil fotoğrafı yüz odaklı olarak yeniden işlendi.`);
    } else {
      message.warning(`${basarili} başarılı, ${basarisiz} başarısız. Detaylar için console'a bakın.`, 8);
    }
    await fetchListe();
  }

  // ── Personel firma scoping (Faz 15b, Plan agent denetimi) ───────────
  // NE: super_admin tüm personeli; diğer yöneticiler (firma_admin) sadece
  //     kendi firmasındaki + gosterilenFirmalar'daki personeli görür.
  // NEDEN: "Yönetici/personel ayrımı çok iyi" (Mehmet Bey) + Plan agent
  //        uyarısı: backend kısıtlamasına güvenirsek çapraz-firma sızıntı
  //        riski var. Frontend defansif post-filter.
  // NASIL: list() çağrısı backend'in döndürdüğü tüm kullanıcıları alır;
  //        biz UI'da rol bazlı filtre uygular sadece görmesi gerekenleri
  //        gösteririz.
  // Deps array'inde array referansı tutmak → her render'da yeni instance
  // → fetchListe yeni instance → useEffect tekrar tetiklenir → sonsuz
  // döngü ("Maximum update depth exceeded"). Çözüm: array'i stable
  // string'e çevir, deps'te string kullan.
  const gosterilenFirmalarKey = (aktifKullanici?.gosterilenFirmalar ?? []).join('|');
  const fetchListe = useCallback(async () => {
    setYukleniyor(true);
    try {
      const data = await api.kullanicilar.list();
      const aktif = data.filter((k) => k.aktifMi);
      const erisilebilirFirmaIds =
        aktifKullanici?.rol === 'super_admin'
          ? null
          : new Set<string>([
              ...(aktifKullanici?.firmaId ? [aktifKullanici.firmaId] : []),
              ...(aktifKullanici?.gosterilenFirmalar ?? []),
            ]);
      const filtreli = erisilebilirFirmaIds
        ? aktif.filter((k) => !k.firmaId || erisilebilirFirmaIds.has(k.firmaId))
        : aktif;
      setListe(filtreli);
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Personel listesi alınamadı.');
    } finally {
      setYukleniyor(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aktifKullanici?.rol, aktifKullanici?.firmaId, gosterilenFirmalarKey]);

  useEffect(() => { void fetchListe(); }, [fetchListe]);

  function yeniPersonel() {
    setDuzenlenen(null);
    form.resetFields();
    form.setFieldsValue({
      rol: 'engineer',
      firmaId: tumFirmalaraErisir ? undefined : aktifKullanici?.firmaId || undefined,
    });
    setModalOpen(true);
  }

  function duzenle(k: Kullanici) {
    setDuzenlenen(k);
    form.setFieldsValue({
      kullaniciAdi: k.kullaniciAdi || '',
      adSoyad: k.adSoyad,
      unvan: k.unvan,
      rol: k.rol,
      firmaId: k.firmaId || undefined,
      gosterilenFirmalar: Array.isArray(k.gosterilenFirmalar) ? k.gosterilenFirmalar : [],
      telefon: k.telefon || '',
      dahili: k.dahili || '',
    });
    setModalOpen(true);
  }

  async function kaydet(values: FormValues) {
    try {
      // Save sirasinda canonical formatta normalize (trailing space yok)
      const normalizedAdSoyad = formatAdSoyad(values.adSoyad ?? '', false);
      const normalizedUnvan = formatUnvan(values.unvan ?? '', false);
      if (duzenlenen) {
        await api.kullanicilar.update(duzenlenen.id, {
          adSoyad: normalizedAdSoyad,
          unvan: normalizedUnvan,
          rol: values.rol,
          gosterilenFirmalar: values.rol === 'firma_admin' ? (values.gosterilenFirmalar ?? []) : [],
          telefon: (values.telefon ?? '').trim(),
          dahili: (values.dahili ?? '').trim(),
        });
        message.success('Personel güncellendi');
      } else {
        const r = await api.kullanicilar.create({
          kullaniciAdi: values.kullaniciAdi.toLowerCase().trim(),
          adSoyad: normalizedAdSoyad,
          unvan: normalizedUnvan,
          rol: values.rol,
          firmaId: tumFirmalaraErisir ? values.firmaId : aktifKullanici?.firmaId || undefined,
          telefon: (values.telefon ?? '').trim(),
          dahili: (values.dahili ?? '').trim(),
        });
        message.success(`${formatAdSoyad(values.adSoyad)} sisteme başarıyla eklendi. Varsayılan şifre: ${r.varsayilanSifre}`);
      }
      setModalOpen(false);
      void fetchListe();
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Kayıt işlemi tamamlanamadı.');
    }
  }

  async function sifreSifirla(k: Kullanici) {
    try {
      const r = await api.kullanicilar.sifirla(k.id);
      // Faz 16 fix: statik Modal.success → message.success (React #185 önle)
      message.success(`${formatAdSoyad(k.adSoyad)} için yeni şifre: ${r.varsayilanSifre} (Personel ilk giriş yapınca yenisini belirleyecek.)`, 12);
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Sıfırlanamadı');
    }
  }

  async function sil(k: Kullanici) {
    try {
      await api.kullanicilar.sil(k.id);
      message.success('Personel pasif edildi');
      void fetchListe();
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Silinemedi');
    }
  }

  const firmaIdToAd = useMemo(() => {
    const m: Record<string, string> = {};
    firmalar.forEach((f) => { m[f.id] = f.kisaAd; });
    return m;
  }, [firmalar]);

  // Personel listesi alfabetik sıralı (tr-locale aware) — tablo görünümü için.
  const listeSirali = useMemo(
    () => [...liste].sort((a, b) => (a.adSoyad || '').localeCompare(b.adSoyad || '', 'tr')),
    [liste],
  );

  const rolEtiket: Record<KullaniciRol, { color: string; label: string }> = {
    super_admin: { color: 'gold',    label: 'Süper Yönetici' },
    firma_admin: { color: 'orange',  label: 'Firma Yöneticisi' },
    engineer:    { color: 'blue',    label: 'Mühendis' },
    sales:       { color: 'green',   label: 'Satış' },
  };

  const columns = [
    {
      title: 'Personel',
      key: 'personel',
      render: (_: unknown, k: Kullanici) => (
        <Space>
          {k.profilFotoUrl
            ? <Avatar src={k.profilFotoUrl} size={36} />
            : <Avatar size={36} icon={<UserOutlined />}>{k.initials}</Avatar>
          }
          <div>
            <div style={{ fontWeight: 600 }}>{formatAdSoyad(k.adSoyad)}</div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>@{k.kullaniciAdi}</div>
          </div>
        </Space>
      ),
    },
    {
      title: 'Ünvan',
      dataIndex: 'unvan',
      key: 'unvan',
      render: (v: string) => v ? formatUnvan(v) : <span style={{ color: '#cbd5e1' }}>—</span>,
    },
    {
      title: 'Telefon',
      key: 'telefon',
      render: (_: unknown, k: Kullanici) => {
        const tel = k.telefon;
        const dah = k.dahili;
        if (!tel && !dah) return <span style={{ color: '#cbd5e1' }}>—</span>;
        return (
          <div style={{ fontSize: 12 }}>
            {tel && <div>{tel}</div>}
            {dah && <div style={{ color: '#94a3b8', fontSize: 11 }}>Dahili: {dah}</div>}
          </div>
        );
      },
    },
    {
      title: 'Rol',
      dataIndex: 'rol',
      key: 'rol',
      render: (rol: KullaniciRol) => {
        const r = rolEtiket[rol] || { color: 'default', label: rol };
        return <Tag color={r.color}>{r.label}</Tag>;
      },
    },
    ...(tumFirmalaraErisir ? [{
      title: 'Firma',
      dataIndex: 'firmaId',
      key: 'firmaId',
      render: (id: string | null) => id ? <Tag>{firmaIdToAd[id] || id}</Tag> : <span style={{ color: '#94a3b8' }}>—</span>,
    }] : []),
    {
      title: 'İlk Giriş',
      key: 'mustChange',
      render: (_: unknown, k: Kullanici) =>
        k.mustChangePassword
          ? <Tag color="red">Şifre değişmemiş</Tag>
          : <Tag color="green">Tamam</Tag>,
    },
    {
      title: 'Mail Hesabı',
      key: 'smtpStatus',
      render: (_: unknown, k: Kullanici) => {
        if (k.smtpPasswordSet && k.smtpUser) {
          return (
            <Tag color="green" style={{ fontSize: 11 }}>
              {k.smtpUser}
            </Tag>
          );
        }
        return <Tag color="red">Kurulmamış</Tag>;
      },
    },
    {
      title: 'İşlemler',
      key: 'actions',
      align: 'right' as const,
      render: (_: unknown, k: Kullanici) => {
        // Yalnızca super_admin hesabı korunur — onu sadece super_admin yönetebilir.
        const targetIsSuperAdmin = k.rol === 'super_admin';
        const yoneticiKilidi = aktifKullanici?.rol !== 'super_admin' && targetIsSuperAdmin;
        return (
          <Space size="small">
            <Button size="small" icon={<EditOutlined />} disabled={yoneticiKilidi} onClick={() => duzenle(k)}>Düzenle</Button>
            <Button size="small" icon={<KeyOutlined />} disabled={yoneticiKilidi} onClick={() => void sifreSifirla(k)}>Şifre</Button>
            <Popconfirm
              title="Personeli pasif duruma getirmek istediğinize emin misiniz?"
              description="Tekrar aktifleştirebilmek için yöneticiye başvurulması gerekir."
              okText="Evet, pasif et"
              cancelText="Vazgeç"
              okButtonProps={{ danger: true }}
              disabled={k.id === aktifKullanici?.id || yoneticiKilidi}
              onConfirm={() => void sil(k)}
            >
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                disabled={k.id === aktifKullanici?.id || yoneticiKilidi}
              >
                Sil
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ padding: '14px 24px 24px', maxWidth: 1280, margin: '0 auto' }}>
      <Card
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>Personel Yönetimi</div>
              <div style={{ fontSize: 12, color: '#64748b', fontWeight: 400 }}>
                {isAdmin
                  ? 'Tüm firmalardaki personeli ve yöneticileri yönetin'
                  : 'Firmanıza ait personeli ekleyip düzenleyin'}
              </div>
            </div>
            <Space size={8}>
              {isAdmin && (
                <Popconfirm
                  title="Tüm profil fotolarını yüz odaklı yeniden işle"
                  description={
                    <div style={{ maxWidth: 280, fontSize: 12, lineHeight: 1.5 }}>
                      Yetki alanındaki tüm kullanıcıların mevcut profil fotoları
                      yeniden indirilip yüz tespiti ile yakınlaştırılır ve kaydedilir.
                      İşlem birkaç dakika sürebilir.
                    </div>
                  }
                  okText="Başlat"
                  cancelText="Vazgeç"
                  onConfirm={tumFotograflariYenidenIsle}
                  disabled={topluIsleniyor}
                >
                  <Button
                    icon={<AimOutlined />}
                    loading={topluIsleniyor}
                    data-tip-target="personel-toplu-foto-isle"
                  >
                    {topluIsleniyor && topluIlerleme
                      ? `İşleniyor… ${topluIlerleme.tamam}/${topluIlerleme.toplam}`
                      : 'Profil Fotolarını Yüz Odaklı İşle'}
                  </Button>
                </Popconfirm>
              )}
              <Button type="primary" icon={<PlusOutlined />} onClick={yeniPersonel} data-tip-target="personel-yeni-ekle">
                Yeni Personel
              </Button>
            </Space>
          </div>
        }
      >
        <Table
          rowKey="id"
          loading={yukleniyor}
          dataSource={listeSirali}
          columns={columns}
          pagination={{ pageSize: 20 }}
          size="middle"
        />
      </Card>

      <Modal
        title={duzenlenen ? `${formatAdSoyad(duzenlenen.adSoyad)} – Düzenle` : 'Yeni Personel Ekle'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        okText={duzenlenen ? 'Kaydet' : 'Ekle'}
        cancelText="Vazgeç"
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={kaydet}
          initialValues={{ rol: 'engineer' }}
        >
          {!duzenlenen && (
            <Form.Item
              name="kullaniciAdi"
              label="Kullanıcı Adı (giriş için)"
              rules={[
                { required: true, message: 'Zorunlu' },
                { pattern: /^[a-z0-9._-]+$/i, message: 'Sadece harf, rakam, . _ -' },
                { min: 3, message: 'En az 3 karakter' },
              ]}
              extra="Personel ilk girişte varsayılan şifre (personel 0000 / yönetici 1234) ile giriş yapacak ve yeni şifre belirleyecek"
            >
              <Input placeholder="örn. ahmet" autoComplete="off" />
            </Form.Item>
          )}
          <Form.Item
            name="adSoyad"
            label="Ad Soyad"
            rules={[{ required: true, message: 'Zorunlu' }]}
            normalize={(val: string) => formatAdSoyad(val ?? '', true)}
          >
            <Input placeholder="örn. Ahmet YILMAZ" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="unvan"
            label="Meslek / Ünvan"
            extra="Örn: Makine Mühendisi, Satış Sorumlusu, Pazarlama Uzmanı"
            normalize={(val: string) => formatUnvan(val ?? '', true)}
          >
            <Input placeholder="Örn. Makine Mühendisi" autoComplete="off" />
          </Form.Item>
          <Form.Item name="telefon" label="Telefon">
            <Input placeholder="0XXX XXX XX XX" autoComplete="off" />
          </Form.Item>
          <Form.Item name="dahili" label="Dahili">
            <Input placeholder="Dahili numara" autoComplete="off" />
          </Form.Item>
          {/* NE: Meslek ile sistem rolünü ayır ve seçim listelerini pencere içinde aç.
              NEDEN: Dışarı açılan liste modal katmanının altında kalıp seçimi engelleyebilir.
              NASIL: Popup'ı alanın ebeveynine bağla; firma adlarıyla aramayı aç.
              YAN ETKİ: Yetkiler ve kayıt verisi değişmez, yalnızca alan sunumu değişir. */}
          <Form.Item name="rol" label="Sistemdeki Görevi" extra="Mesleği yukarıya yazın; burada sistemdeki görevini seçin." rules={[{ required: true }]}>
            <Select getPopupContainer={(t) => t.parentElement ?? document.body}>
              <Select.Option value="engineer">Mühendis</Select.Option>
              <Select.Option value="sales">Satış Sorumlusu</Select.Option>
              {isAdmin && (
                <Select.Option value="firma_admin">
                  Firma Yöneticisi
                </Select.Option>
              )}
            </Select>
          </Form.Item>
          {/* Firma yoneticisi (firma_admin) icin opsiyonel firma kisitlamasi:
              bos birakirsa TUM firmalara erisir; liste secilirse sadece o
              firmalara erisir. Bu UI olmadan eski yoneticiler logoya basinca
              farkli firmaya gecemiyordu. */}
          <Form.Item
            noStyle
            shouldUpdate={(prev, curr) => prev.rol !== curr.rol}
          >
            {({ getFieldValue }) =>
              getFieldValue('rol') === 'firma_admin' ? (
                <Form.Item
                  name="gosterilenFirmalar"
                  label="Erişebileceği Firmalar"
                  tooltip="Boş bırakılırsa tüm firmalara erişir (varsayılan). Belirli firma seçilirse sadece o firmalara erişebilir."
                >
                  <Select
                    mode="multiple"
                    allowClear
                    placeholder="Boş = tüm firmalar"
                    options={firmalar.map((f) => ({ value: f.id, label: f.ad }))}
                    getPopupContainer={(t) => (t.parentNode as HTMLElement) ?? document.body}
                  />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          {tumFirmalaraErisir && !duzenlenen && (
            <Form.Item
              noStyle
              shouldUpdate={(prev, curr) => prev.rol !== curr.rol}
            >
              {() => {
                return (
                  <Form.Item name="firmaId" label="Firma" rules={[{ required: true, message: 'Firma seçiniz' }]}>
                    <Select
                      placeholder="Firma seçin"
                      showSearch
                      optionFilterProp="children"
                      getPopupContainer={(t) => t.parentElement ?? document.body}
                    >
                      {firmalar.map((f) => (
                        <Select.Option key={f.id} value={f.id}>{f.ad}</Select.Option>
                      ))}
                    </Select>
                  </Form.Item>
                );
              }}
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}
