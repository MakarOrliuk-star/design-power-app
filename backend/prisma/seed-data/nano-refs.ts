// BrandNanoRef reference images (Person generation), keyed by Brand.name.
// 1..3 pre-baked Cloudinary URLs per brand — the fanout pairs Ref(i) with the
// user's uploaded image. Source: user-supplied table. Keys MUST match Brand.name.

export const BRAND_NANO_REFS: Record<string, string[]> = {
  "Frogyspin_women_red": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779114829/9_ntxw3s.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779114829/8_pdrycw.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779114829/10_qntjlp.jpg",
  ],
  "Frogyspin_women_black": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779178854/1_c7uqmf.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779178854/7_gdrfva.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779178854/4_lwfgst.jpg",
  ],
  "Frogyspin(Men)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779188460/5_ooohvo.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779188460/3_nlocik.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779188460/1_athp4w.jpg",
  ],
  "Scizino": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779193125/6_hoty4u.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779193125/4_y7otqy.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779193124/1_z9drog.jpg",
  ],
  "Slotexity": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779193635/2_vgazoz.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779193636/5_g5ebms.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779193636/7_foy4bp.jpg",
  ],
  "Slotrize(Men)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779194251/2_kxuj1p.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779194253/3_x80s0k.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779194250/1_y7oqqk.jpg",
  ],
  "Slotrize(Duck)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779194275/2_pzabs8.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779194270/1_zbhhxc.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779194278/3_qebusg.jpg",
  ],
  "Spinogrino": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779195720/4_wkurp9.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779195721/5_ssyjsk.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779195723/9_dxzwfm.jpg",
  ],
  "TeddySlot": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779197033/4_nw9ujr.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779197034/8_obhueh.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779197036/9_vsum3r.jpg",
  ],
  "Betnella(Men)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779269619/character_10_drsm1a.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779269619/character_8_vj6e3g.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779269619/character_3_dwnruh.jpg",
  ],
  "Betnella(Women)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779269619/character_4_z6xxxi.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779269619/character_9_bwp6zf.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779269619/character_5_hsbnmj.jpg",
  ],
  "Gamblerina": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779270530/character_7_jcu9r6.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779270530/character_5_tkqnwn.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779270529/character_4_avdj5t.jpg",
  ],
  "Gangstasino(Men)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779270920/character_1_xz5wyu.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779270923/character_5_lvnqxl.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779270921/character_3_xpfhsc.jpg",
  ],
  "Gangstasino(Women)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779270921/character_2_srr5f7.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779270922/character_4_ujwk9n.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779270924/character_9_h92y9w.jpg",
  ],
  "Glitzbets(Men)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779271117/character_1_tnms10.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779271119/character_4_cspyub.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779271120/character_5_yzxowj.jpg",
  ],
  "Glitzbets(Women)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779271118/character_3_eu3d36.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779271121/character_7_om76nn.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779271122/character_8_mwnp4y.jpg",
  ],
  "Riverspin": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779271234/character_4_njao11.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779271235/character_8_qir5wu.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779271236/character_10_z7uws7.jpg",
  ],
  "Liraluck(Men)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779351767/character_6_zam7uz.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779351769/character_3_ev10vk.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779351767/character_4_qdit0q.jpg",
  ],
  "Liraluck(Women)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779351768/character_9_wpfhce.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779351768/character_1_k8ffim.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779351768/character_5_zagjbr.jpg",
  ],
  "Tesorcasino(Men)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779351989/character_9_kawguu.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779351988/character_8_qd85yf.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779351988/character_1_pcqg1c.jpg",
  ],
  "Tesorcasino(Women)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779351989/character_10_rdovc8.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779351988/character_4_v53dtg.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779351987/character_2_onmnpx.jpg",
  ],
  "Thorfortune": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779352100/character_1_nm100h.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779352101/character_5_lybxud.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779352101/character_2_ke34vm.jpg",
  ],
  "Rooksbet": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779353012/character_4_qtjqc3.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779353013/character_5_byki5y.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779353012/character_3_gzyqey.jpg",
  ],
  "Royalzino": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779353608/character_1_cfu242.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779353608/character_2_uapyht.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779353608/character_6_tymow1.jpg",
  ],
  "Spinstein": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779353672/character_1_wfhuad.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779353674/character_5_rif4rp.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779353675/character_10_tkk6m7.jpg",
  ],
  "Beezyspin": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779435867/character_2_es1lp4.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779435867/character_4_ahhmdq.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779435867/character_6_lhekaf.png",
  ],
  "Betsamuro(Men)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779435931/character_8_zcgpk7.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779435931/character_7_rayj8b.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779435932/character_10_l3utyc.png",
  ],
  "Betsamuro(Women)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779435932/character_9_rxxd7k.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779435930/character_4_vlggwq.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779435930/character_5_wpqejm.png",
  ],
  "BONUSERIA": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779436197/character_10_pzxtrb.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779436196/character_8_kfsipc.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779436195/character_6_o0giu1.png",
  ],
  "Lamalucky": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779436258/character_8_pw85zr.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779436257/character_5_m28cjk.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779436256/character_2_z7zgd2.jpg",
  ],
  "Luckysheriff(Dog)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779436316/dog_11_iaxvj9.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779436318/dog_12_mgs8qh.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779436319/dog_13_su5zdq.jpg",
  ],
  "Luckysheriff(Sheriff)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779436336/sheriff_1_yse8hw.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779436337/sheriff_5_cqm8bt.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779436338/sheriff_6_lrifcy.jpg",
  ],
  "Rollflame": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779436417/character_7_mchx9l.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779436419/character_8_vxloao.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779436416/character_1_dnptzd.jpg",
  ],
  "Noodlespin(Panda)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698617/character_7_wsxwge.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698616/character_8_qi68n2.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698615/character_4_v6jq87.png",
  ],
  "Noodlespin(Bussel)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698616/character_9_tzsljs.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698616/character_6_zwrdcb.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698615/character_5_dfk29w.png",
  ],
  "Oopspin(Men)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698818/man_5_vvke9a.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698817/man_1_p6bi47.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698817/man_2_ssb19l.jpg",
  ],
  "Oopspin(Women)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698847/woman_16_awgawr.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779782264/woman_15_slojtu.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698846/woman_11_pbvl78.jpg",
  ],
  "Rollambia(Men)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698973/man_2_jtl7tp.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698974/man_3_jkfwyf.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698975/man_4_gt0xfr.jpg",
  ],
  "Rollambia(Women)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698996/woman_14_hf8psw.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698995/woman_12_lfmyup.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779698994/woman_11_mwio7o.jpg",
  ],
  "Highflybet(Men)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779798089/5_bqfnja.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779798088/4_m6obj2.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779798088/2_ucxqpg.jpg",
  ],
  "Highflybet(Women)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779798143/5_lkomef.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779798143/4_xa2huo.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779798142/3_ngqcgb.jpg",
  ],
  "Fridayroll(Men)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779868071/5_ndjnzt.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779868070/3_qq2xta.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779868070/4_qmsfpy.jpg",
  ],
  "Fridayroll(Women)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779868082/5_uzjnpf.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779868082/4_ohaleh.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779868081/1_okof7i.jpg",
  ],
  "Duckysino": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779870072/13_zx7raq.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779870072/9_ctwde8.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779870071/8_dpko9c.png",
  ],
  "Rockyspin": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779872958/9_lyt6jb.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779872957/6_oyxfol.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779872956/5_xgejzh.png",
  ],
  "Nyxbets(Men)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779876263/1_jojalv.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779876266/5_qsplcy.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779876282/2_bn9vz8.jpg",
  ],
  "Nyxbets(Women)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779876321/5_nz7eap.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779876314/4_hirjvh.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779876308/3_r3l7hh.jpg",
  ],
  "Royalstiger": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779955279/7_eb7l90.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779955279/12_r1wtbd.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779955279/1_uzawjf.jpg",
  ],
  "Piperspin": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779955888/4_gtztys.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779955882/3_a1yiii.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779955881/2_a2gdki.jpg",
  ],
  "Goldzino(Women)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779959334/cortexudesign05_____--chaos_50_--ar_6471_--raw_--v_6.1_404ce368-dab6-46f7-b395-b38f40ad928a_eboviw.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779959330/cortexudesign05_____--chaos_50_--ar_1617_--raw_--v_6.1_64e1754c-28b4-4105-80cc-c8feb0e13964_hsb1r5.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1779959328/cortexudesign05_____--chaos_50_--ar_3237_--raw_--v_6.1_df4caeca-2f40-48e6-baf6-ee9173dd7df9_gvlwb1.png",
  ],
  "Magneticslots": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1778770525/3_mlhuki.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1778770525/3_mlhuki.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1778770525/2_vullmz.jpg",
  ],
  "Spinwinera": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780039660/15_ykerrt.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780039659/13_fwknue.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780039657/3_saqxmg.jpg",
  ],
  "Makispin": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780040784/13_spnp3f.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780040781/3_bwshmx.png",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780040780/2_ksdmyv.png",
  ],
  "Spinania": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780043697/3_zcpfxp.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780043694/2-1_xy2eup.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780043692/1_veqv5l.jpg",
  ],
  "Manekispin": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780060615/13_wmkphz.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780060611/6_ppzfms.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780060609/3_wqogeg.jpg",
  ],
  "Senseizino(Women)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780061116/10_mpahua.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780061111/8_rd3cld.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780061088/6_o1g5nn.jpg",
  ],
  "Senseizino(Men)": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780061264/6_bdtz9m.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780061258/5_rbhzgw.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780061254/3_c9zwzs.jpg",
  ],
  "Honeybetz": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780062067/8_vjavva.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780062063/2_gghbbz.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780062058/1_gcq29t.jpg",
  ],
  "Bonuskong": [
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780062560/5_iwo7x7.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780062552/4_l3smmc.jpg",
    "https://res.cloudinary.com/dk9ecwmdp/image/upload/v1780062548/3_oifisl.jpg",
  ],
};
