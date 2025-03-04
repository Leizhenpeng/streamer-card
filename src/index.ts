import express from 'express'; // 引入 Express 框架
import { Cluster } from 'puppeteer-cluster'; // 引入 Puppeteer Cluster 库，用于并发浏览器任务
import MarkdownIt from 'markdown-it'; // 引入 Markdown-It 库，用于解析 Markdown 语法
import { LRUCache } from 'lru-cache'; // 引入 LRU 缓存库，并注意其导入方式
import { Request, Response } from 'express';
const md = new MarkdownIt({breaks: false}); // 初始化 Markdown-It，并设置换行符解析选项
const port = 3003; // 设置服务器监听端口
const url = 'https://fireflycard.shushiai.com/'; // 要访问的目标 URL
// const url = 'http://localhost:3000/'; // 要访问的目标 URL
const scale = 2; // 设置截图的缩放比例，图片不清晰就加大这个数值
const maxRetries = 3; // 设置请求重试次数
const maxConcurrency = 10; // 设置 Puppeteer 集群的最大并发数
const app = express(); // 创建 Express 应用
app.use(express.json()); // 使用 JSON 中间件
app.use(express.urlencoded({extended: false})); // 使用 URL 编码中间件

let cluster; // 定义 Puppeteer 集群变量

// 设置 LRU 缓存，最大缓存项数和最大内存限制
const cache = new LRUCache<string, Buffer>({
    max: 100, // 缓存最大项数，可以根据需要调整
    maxSize: 50 * 1024 * 1024, // 最大缓存大小 50MB
    sizeCalculation: (value: Buffer) => {
        return value.byteLength; // 使用Buffer的byteLength属性计算大小
    },
    ttl: 600 * 1000, // 缓存项 10 分钟后过期
    allowStale: false, // 不允许使用过期的缓存项
    updateAgeOnGet: true, // 获取缓存项时更新其年龄
});

// 初始化 Puppeteer 集群
async function initCluster() {
    cluster = await Cluster.launch({
        concurrency: Cluster.CONCURRENCY_CONTEXT, // 使用上下文并发模式
        maxConcurrency: maxConcurrency, // 设置最大并发数
        puppeteerOptions: {
            args: [
                '--disable-dev-shm-usage', // 禁用 /dev/shm 使用
                '--disable-setuid-sandbox', // 禁用 setuid sandbox
                '--no-first-run', // 禁止首次运行
                '--no-sandbox', // 禁用沙盒模式
                '--no-zygote' // 禁用 zygote
            ],
            headless: true, // 无头模式
            protocolTimeout: 120000 // 设置协议超时
        }
    });

    // 处理任务错误
    cluster.on('taskerror', (err, data) => {
        console.error(`任务处理错误: ${data}: ${err.message}`);
    });

    console.log('Puppeteer 集群已启动');
}

// 生成请求唯一标识符
function generateCacheKey(body) {
    return JSON.stringify(body); // 将请求体序列化为字符串
}

// 处理请求的主要逻辑
async function processRequest(req: Request) {
    const body = req.body; // 获取请求体
    const cacheKey = generateCacheKey(body); // 生成缓存键

    // 检查缓存中是否有结果
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
        console.log('从缓存中获取结果');
        return cachedResult; // 返回缓存结果
    }

    console.log('处理请求，内容为:', JSON.stringify(body));
    let iconSrc = body.icon;
    // 是否使用字体
    let useLoadingFont = body.useLoadingFont;
    let params = new URLSearchParams(); // 初始化 URL 查询参数
    params.append("isApi","true")
    let blackArr = ['icon', 'switchConfig', 'content', 'translate']; // 定义不需要加入查询参数的键

    for (const key in body) {
        if (!blackArr.includes(key)) {
            params.append(key, body[key]); // 添加其他参数
        } else if (key === 'switchConfig') {
            params.append(key, JSON.stringify(body[key])); // 序列化 switchConfig
        }
    }

    const result = await cluster.execute({
        url: url + '?' + params.toString(),
        body,
        iconSrc,
    }, async ({page, data}) => {
        const {url, body, iconSrc} = data;
        await page.setRequestInterception(true);
        page.on('request', req => {
            if (!useLoadingFont && req.resourceType() === 'font') {
                req.abort();
            } else {
                req.continue();
            }
        });

        const viewPortConfig = {width: 1920, height: 1080+200};
        await page.setViewport(viewPortConfig);
        console.log('视口设置为:', viewPortConfig);

        await page.goto(url, {
            timeout: 60000,
            waitUntil: ['load', 'networkidle2']
        });
        console.log('页面已导航至:', url);

        if (useLoadingFont) {
            await page.waitForFunction('document.fonts.status === "loaded"');
        }

        await delay(3000);

        // 更新卡片元素选择器
        const cardElement = await page.$(`.${body.temp || 'tempB'}`);
        if (!cardElement) {
            throw new Error('请求的卡片不存在');
        }
        console.log('找到卡片元素');

        let translate = body.translate;
        if (translate) {
            await page.evaluate((translate) => {
                const translateEl = document.querySelector('[name="showTranslation"]');
                if (translateEl) translateEl.innerHTML = translate;
            }, translate);
        }

        let content = body.content;
        let isContentHtml = body.isContentHtml;
        if (content) {
            let html = content;
            if (!isContentHtml) {
                content = content.replace(/\n\n/g, '--br----br--');
                html = md.render(content);
                html = html.replace(/--br--/g, '<br/>').replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
            }
            await page.evaluate(html => {
                const contentEl = document.querySelector('.md-class.editable-element');
                if (contentEl) contentEl.innerHTML = html;
            }, html);
            console.log('卡片内容已设置');
        }

        // 设置标题
        if (body.title) {
            await page.evaluate((title) => {
                const titleEl = document.querySelector('[data-split="showTitle"] .editable-element-new');
                if (titleEl) titleEl.innerHTML = title;
            }, body.title);
        }

        // 设置日期
        if (body.date) {
            await page.evaluate((date) => {
                const dateEl = document.querySelector('[data-split="showDate"] .editable-element-new');
                if (dateEl) dateEl.innerHTML = date;
            }, body.date);
        }

        // 设置作者
        if (body.author) {
            await page.evaluate((author) => {
                const authorEl = document.querySelector('[data-split="showAuthor"] .editable-element-new');
                if (authorEl) authorEl.innerHTML = author;
            }, body.author);
        }

        if (iconSrc && iconSrc.startsWith('http')) {
            await page.evaluate(function(imgSrc) {
                return new Promise(function(resolve) {
                    var imageElement:any = document.querySelector('#icon');
                    console.log("头像", imageElement);
                    if (imageElement) {
                        imageElement.src = imgSrc;
                        imageElement.addEventListener('load', function() { resolve(true); });
                        imageElement.addEventListener('error', function() { resolve(true); });
                    } else {
                        resolve(false);
                    }
                });
            }, iconSrc);
            console.log('图标已设置');
        }

        const boundingBox = await cardElement.boundingBox(); // 获取卡片元素边界框
        if (boundingBox.height > viewPortConfig.height) {
            await page.setViewport({width: 1920, height: Math.ceil(boundingBox.height)+200}); // 调整视口高度
        }
        console.log('找到边界框并调整视口');
        let imgScale = body.imgScale ? body.imgScale: scale;
        console.log('图片缩放比例为:', imgScale)
        const buffer = await page.screenshot({
            type: 'png', // 设置截图格式为 PNG
            clip: {
                x: boundingBox.x,
                y: boundingBox.y,
                width: boundingBox.width,
                height: boundingBox.height,
                scale: imgScale // 设置截图缩放比例
            },
            timeout: 60000, // 设置截图超时
        });
        console.log('截图已捕获');

        return buffer; // 返回截图
    });

    
    // 检查缓存大小，确保不会超过限制
    const currentCacheSize = cache.size;
    if (currentCacheSize + result.length <= cache.maxSize) {
        // 将结果缓存
        cache.set(cacheKey, result);
    } else {
        console.warn('缓存已满，无法缓存新的结果');
    }

    return result; // 返回处理结果
}

// 处理保存图片的 POST 请求
app.post('/saveImg', async (req: Request, res: Response) => {
    let attempts = 0;
    while (attempts < maxRetries) {
        try {
            const buffer = await processRequest(req);
            res.setHeader('Content-Type', 'image/png');
            res.status(200).send(buffer);
            return;
        } catch (error) {
            console.error(`第 ${attempts + 1} 次尝试失败:`, error);
            attempts++;
            if (attempts >= maxRetries) {
                res.status(500).send(`处理请求失败，已重试 ${maxRetries} 次`);
            } else {
                await delay(1000);
            }
        }
    }
});

// 处理进程终止信号
process.on('SIGINT', async () => {
    if (cluster) {
        await cluster.idle();
        await cluster.close();
    }
    process.exit();
});

// 启动服务器并初始化 Puppeteer 集群
app.listen(port, async () => {
    console.log(`监听端口 ${port}...`);
    await initCluster();
});

// 延迟函数，用于等待指定的毫秒数
function delay(timeout) {
    return new Promise(resolve => setTimeout(resolve, timeout));
}
