import {expect,test} from '@playwright/test';

test('ranking switches never paint rows from the previous element',async({page,context,baseURL})=>{
  test.setTimeout(90_000);
  await context.addCookies([{name:'tof_locale',value:'en',url:baseURL!}]);
  let requests=0;
  await page.route(url=>url.pathname==='/api/v1/ranking/players',async route=>{
    requests++;
    const physical=new URL(route.request().url()).searchParams.get('track')==='Physical';
    await route.fulfill({json:{available:true,total:1,entries:[{
      rank:1,score:50,maxScore:100,track:physical?'Physical':'Volt',
      player:{uid:physical?'200':'100',nickname:physical?'Physical fixture':'All fixture',region:'EU',serverId:null},
      gear:[],buildId:null,
    }]}});
  });
  await page.goto('/tools/ranking/',{waitUntil:'domcontentloaded'});
  const physical=page.locator('button[data-val="Physical"]');
  const all=page.getByRole('group').filter({has:physical}).locator('button[data-val="all"]');
  await expect(page.getByText('All fixture',{exact:true})).toBeVisible({timeout:60_000});
  await page.evaluate(()=>{
    const invalid: string[]=[];
    Object.assign(window,{rankingWrongRows:invalid});
    const observer=new MutationObserver(()=>{
      const physical=document.querySelector('button[data-val="Physical"][aria-pressed="true"]');
      const rows=document.querySelector('[role="table"]')?.textContent??'';
      if (physical&&rows.includes('All fixture')) invalid.push('All under Physical');
      if (!physical&&rows.includes('Physical fixture')) invalid.push('Physical under All');
    });
    observer.observe(document.body,{attributes:true,childList:true,characterData:true,subtree:true});
  });
  await physical.click();
  await expect(page.getByText('Physical fixture',{exact:true})).toBeVisible();
  await all.click();
  await expect(page.getByText('All fixture',{exact:true})).toBeVisible();
  await physical.click();
  await expect(page.getByText('Physical fixture',{exact:true})).toBeVisible();
  expect(requests).toBe(2);
  expect(await page.evaluate(()=>(window as Window&{rankingWrongRows:string[]}).rankingWrongRows)).toEqual([]);
});
