import {test,expect} from '@playwright/test';
import fixture from '../../apps/web/src/features/build/__fixtures__/catalog.json';

for(const locale of ['en','ru'])test(`Ranking detail scores align and mobile gear stays readable (${locale})`,async({page,context,baseURL})=>{
  test.setTimeout(90_000);
  await context.addCookies([{name:'tof_locale',value:locale,url:baseURL!}]);
  const gear=fixture.demoDraft.gear.map((item,index)=>({id:`piece-${index}`,slot:item.id,itemId:item.id,stars:item.stars,enhancement:item.enhancement,titan:item.titan,augmented:item.augmented,
    source:'self',rareId:item.rareId,rareLevel:item.rareLevel,stats:item.rows.map(row=>({type:row.type,value:row.value})),statsBeforeTitan:item.rows.map(row=>row.beforeTitan),augments:item.augments,lastSeenAt:'2026-10-18T00:00:00Z'}));
  let pieceRankRequests=0;
  await page.route('**/api/v1/ranking/**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/gear/ranks')){
      pieceRankRequests++;
      return route.fulfill({json:{available:true,ranks:Object.fromEntries(gear.map((item,index)=>[item.id,index+12]))}});
    }
    if(url.pathname.endsWith('/rank'))return route.fulfill({json:{available:true,rank:2}});
    return route.fulfill({json:{available:true,total:1,overall:1,entries:[{rank:4,score:87.3,maxScore:100,track:'Frost',
      player:{uid:'1302104471',nickname:'Layout player',region:'EU',serverId:'13021'},gear,buildId:null,updatedAt:'2026-10-18T00:00:00Z'}]}});
  });
  await page.goto('/tools/ranking/?track=Frost');
  const row=page.getByRole('row').filter({has:page.getByText('Layout player',{exact:true})});
  const openDetails=row.getByRole('button',{name:locale==='ru'?'Показать детали':'Show details',exact:true});
  await row.hover();
  await openDetails.focus();
  expect(pieceRankRequests).toBe(0);
  await openDetails.press('Enter');
  const details=page.locator('#player-top-4'),potential=details.locator('[class*="potentialSlot"]');
  await expect(details.getByText('#12',{exact:true})).toBeVisible();
  expect(pieceRankRequests).toBe(1);
  await expect(potential.getByRole('meter')).toBeVisible();
  await expect(details.locator('[class*="slotCard"]')).toHaveCount(12);
  for(const width of [1440,1280,1100,1024,900,768,560,390,320]){
    await page.setViewportSize({width,height:1000});
    const current=await row.getByRole('meter').boundingBox(),projected=await potential.getByRole('meter').boundingBox();
    expect(Math.abs(current!.x+current!.width-projected!.x-projected!.width),`${width}: score right edges`).toBeLessThan(2);
    const nickname=await row.getByText('Layout player',{exact:true}).boundingBox();
    expect(nickname!.x+nickname!.width,`${width}: nickname stays before GRV`).toBeLessThanOrEqual(current!.x);
    if(width>1100)expect(Math.abs(current!.x-projected!.x),`${width}: score left edges`).toBeLessThan(2);
    const expand=await row.getByRole('button').last().boundingBox(),compare=await details.getByRole('button',{name:locale==='ru'?'Включить сравнение':'Enable comparison',exact:true}).boundingBox();
    expect(Math.abs(expand!.x-compare!.x),`${width}: action column`).toBeLessThan(2);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width}: page overflow`).toBe(true);
    if(width<1024){
      const rail=await page.locator('main header').first().boundingBox();
      const contentWidth=await page.evaluate(()=>document.documentElement.getBoundingClientRect().width);
      expect(Math.abs(rail!.x+rail!.width/2-contentWidth/2),`${width}: rail centered`).toBeLessThan(2);
      expect(rail!.y+rail!.height,`${width}: rail at viewport bottom`).toBeGreaterThan(950);
    }
    const overflowing=await details.locator('[class*="slotCard"]').evaluateAll(cards=>cards.some(card=>card.scrollWidth>card.clientWidth+1));
    expect(overflowing,`${width}: gear card overflow`).toBe(false);
    if(width<=560){
      expect(await details.locator('[class*="slotCard"]>span>b').evaluateAll(names=>names.some(name=>name.scrollWidth>name.clientWidth+1)),`${width}: mobile gear titles`).toBe(false);
    }
    if([1440,768,390,320].includes(width)){
      await page.mouse.move(0,0);
      await page.screenshot({path:`ignore/documentation-media/generated/ranking-details-${locale}-${width}.png`,fullPage:true,animations:'disabled'});
    }
  }
});
