const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();

// Adicionando CORS para permitir o header personalizado
app.use(cors({
    origin: '*', // Permite qualquer origem
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'x-admin-senha']
}));

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const SENHA_SECRETA = process.env.ADMIN_PASSWORD || "flavio123";
const DB_FILE = path.join(__dirname, 'produtos.json');

if (!fs.existsSync(DB_FILE)) { fs.writeFileSync(DB_FILE, JSON.stringify([])); }

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Middleware para verificar a senha
const verificarSenha = (req, res, next) => {
    const senhaRecebida = (req.headers['x-admin-senha'] || '').trim();  // Adicionando o .trim() para evitar problemas com espaços extras
    if (senhaRecebida === SENHA_SECRETA) next(); 
    else res.status(401).json({ error: 'Senha incorreta.' });
};

// --- ROTA DE CONTAR CLIQUES (NOVA) ---
app.post('/products/:id/click', (req, res) => {
    try {
        const { id } = req.params;
        let data = JSON.parse(fs.readFileSync(DB_FILE));
        
        // Encontra o produto e aumenta o contador de clicks
        const index = data.findIndex(p => p.id == id);
        if (index !== -1) {
            // Se não tiver cliques ainda, começa com 0 e soma 1
            data[index].clicks = (data[index].clicks || 0) + 1;
            
            fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
            console.log(`---> POPULARIDADE: Produto ${id} recebeu um clique. Total: ${data[index].clicks}`);
            res.json({ success: true, clicks: data[index].clicks });
        } else {
            res.status(404).json({ error: 'Produto não encontrado' });
        }
    } catch (e) {
        console.error("Erro ao registrar clique:", e);
        res.status(500).json({ error: 'Erro no servidor' });
    }
});

// --- SCRAPING (Preço Sniper V3 + Categoria Manual) ---
app.get('/scrape', async (req, res) => {
    let { url, category } = req.query;
    if (!url) return res.status(400).json({ error: 'URL necessária' });

    const categoriaFinal = category || "Geral";
    console.log(`---> ALVO: ${url} | CATEGORIA: ${categoriaFinal}`);

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: "new", 
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        const isSocial = await page.evaluate(() => window.location.href.includes('social') || document.title.includes('Social') || document.title.includes('Perfil'));
        
        if (isSocial) {
            try {
                const productLink = await page.evaluate(() => {
                    const link = document.querySelector('a[href*="/p/MLB"]');
                    return link ? link.href : null;
                });
                if (productLink) await page.goto(productLink, { waitUntil: 'domcontentloaded', timeout: 60000 });
            } catch (e) {}
        }

        try { await page.waitForSelector('.andes-money-amount', { timeout: 5000 }); } catch(e){}

        const productData = await page.evaluate(() => {
            const title = document.querySelector('h1.ui-pdp-title')?.innerText || document.title;
            let price = null;

            const metaPrice = document.querySelector('meta[itemprop="price"]');
            if (metaPrice && metaPrice.content) price = parseFloat(metaPrice.content);

            if (!price) {
                const pricesFound = [];
                const allElements = document.querySelectorAll('.andes-money-amount');
                allElements.forEach(el => {
                    const isStrike = el.closest('.ui-pdp-price__original-value') || el.closest('.andes-money-amount--previous') || el.closest('s');
                    const parentText = el.parentElement ? el.parentElement.innerText.toLowerCase() : "";
                    const isInstallment = el.closest('.ui-pdp-price__subtitles') || parentText.includes('x');

                    if (!isStrike && !isInstallment) {
                        const fraction = el.querySelector('.andes-money-amount__fraction')?.innerText.replace(/\./g, '');
                        const cents = el.querySelector('.andes-money-amount__cents')?.innerText || '00';
                        if (fraction) {
                            const val = parseFloat(fraction + '.' + cents);
                            if (val > 10) pricesFound.push(val);
                        }
                    }
                });
                if (pricesFound.length > 0) price = Math.min(...pricesFound);
            }

            let image = document.querySelector('meta[property="og:image"]')?.content;
            if (!image) image = document.querySelector('figure.ui-pdp-gallery__figure img')?.src;
            if (!image) image = document.querySelector('img.ui-pdp-image')?.src;

            return { title, price, thumbnail: image };
        });

        if (!productData.title || !productData.price) throw new Error("Dados incompletos.");

        res.json({ 
            title: productData.title, 
            price: productData.price, 
            category: categoriaFinal, 
            thumbnail: productData.thumbnail, 
            link: url 
        });

    } catch (error) {
        console.error("Erro Puppeteer:", error.message);
        res.status(500).json({ error: 'Erro ao processar. Tente o modo Manual.' });
    } finally {
        if (browser) await browser.close();
    }
});

// CRUD + ROTAÇÃO
app.get('/products', (req, res) => { try { res.json(JSON.parse(fs.readFileSync(DB_FILE))); } catch (e) { res.json([]); } });

app.post('/products', verificarSenha, (req, res) => {
    try {
        const newProduct = { id: Date.now(), clicks: 0, ...req.body }; // Começa com 0 clicks
        let data = [];
        if (fs.existsSync(DB_FILE)) data = JSON.parse(fs.readFileSync(DB_FILE));

        data.unshift(newProduct);
        if (data.length > 200) data.pop(); 

        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        res.json(newProduct);
    } catch (e) { res.status(500).json({ error: 'Erro ao gravar.' }); }
});

app.delete('/products/:id', verificarSenha, (req, res) => {
    const { id } = req.params;
    let data = JSON.parse(fs.readFileSync(DB_FILE));
    data = data.filter(prod => prod.id != id);
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`Servidor V10 (Popularidade) rodando na porta ${PORT}`));
