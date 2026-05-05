// stock-autocomplete.js - Shared auto-complete functionality for stock ticker inputs

// S&P 500 tickers (2024) - Complete list of all S&P 500 companies
const TICKER_LIST = [
    { ticker: "A", name: "Agilent Technologies Inc." },
    { ticker: "AAL", name: "American Airlines Group Inc." },
    { ticker: "AAP", name: "Advance Auto Parts Inc." },
    { ticker: "AAPL", name: "Apple Inc." },
    { ticker: "ABBV", name: "AbbVie Inc." },
    { ticker: "ABNB", name: "Airbnb Inc." },
    { ticker: "ABT", name: "Abbott Laboratories" },
    { ticker: "ACGL", name: "Arch Capital Group Ltd." },
    { ticker: "ACN", name: "Accenture plc" },
    { ticker: "ADBE", name: "Adobe Inc." },
    { ticker: "ADI", name: "Analog Devices Inc." },
    { ticker: "ADM", name: "Archer-Daniels-Midland Company" },
    { ticker: "ADP", name: "Automatic Data Processing Inc." },
    { ticker: "ADSK", name: "Autodesk Inc." },
    { ticker: "AEE", name: "Ameren Corporation" },
    { ticker: "AEP", name: "American Electric Power Company Inc." },
    { ticker: "AES", name: "The AES Corporation" },
    { ticker: "AFL", name: "Aflac Incorporated" },
    { ticker: "AIG", name: "American International Group Inc." },
    { ticker: "AIZ", name: "Assurant Inc." },
    { ticker: "AJG", name: "Arthur J. Gallagher & Co." },
    { ticker: "AKAM", name: "Akamai Technologies Inc." },
    { ticker: "ALB", name: "Albemarle Corporation" },
    { ticker: "ALGN", name: "Align Technology Inc." },
    { ticker: "ALL", name: "The Allstate Corporation" },
    { ticker: "ALLE", name: "Allegion plc" },
    { ticker: "AMAT", name: "Applied Materials Inc." },
    { ticker: "AMCR", name: "Amcor plc" },
    { ticker: "AMD", name: "Advanced Micro Devices Inc." },
    { ticker: "AME", name: "AMETEK Inc." },
    { ticker: "AMGN", name: "Amgen Inc." },
    { ticker: "AMP", name: "Ameriprise Financial Inc." },
    { ticker: "AMT", name: "American Tower Corporation" },
    { ticker: "AMZN", name: "Amazon.com Inc." },
    { ticker: "ANET", name: "Arista Networks Inc." },
    { ticker: "ANSS", name: "ANSYS Inc." },
    { ticker: "AON", name: "Aon plc" },
    { ticker: "AOS", name: "A. O. Smith Corporation" },
    { ticker: "APA", name: "APA Corporation" },
    { ticker: "APD", name: "Air Products and Chemicals Inc." },
    { ticker: "APH", name: "Amphenol Corporation" },
    { ticker: "APTV", name: "Aptiv PLC" },
    { ticker: "ARE", name: "Alexandria Real Estate Equities Inc." },
    { ticker: "ATO", name: "Atmos Energy Corporation" },
    { ticker: "AVGO", name: "Broadcom Inc." },
    { ticker: "AVB", name: "AvalonBay Communities Inc." },
    { ticker: "AVY", name: "Avery Dennison Corporation" },
    { ticker: "AWK", name: "American Water Works Company Inc." },
    { ticker: "AXON", name: "Axon Enterprise Inc." },
    { ticker: "AXP", name: "American Express Company" },
    { ticker: "AZO", name: "AutoZone Inc." },
    { ticker: "BA", name: "The Boeing Company" },
    { ticker: "BAC", name: "Bank of America Corporation" },
    { ticker: "BALL", name: "Ball Corporation" },
    { ticker: "BAX", name: "Baxter International Inc." },
    { ticker: "BBWI", name: "Bath & Body Works Inc." },
    { ticker: "BBY", name: "Best Buy Co. Inc." },
    { ticker: "BDX", name: "Becton Dickinson and Company" },
    { ticker: "BEN", name: "Franklin Resources Inc." },
    { ticker: "BF.B", name: "Brown-Forman Corporation" },
    { ticker: "BIIB", name: "Biogen Inc." },
    { ticker: "BIO", name: "Bio-Rad Laboratories Inc." },
    { ticker: "BK", name: "The Bank of New York Mellon Corporation" },
    { ticker: "BKNG", name: "Booking Holdings Inc." },
    { ticker: "BKR", name: "Baker Hughes Company" },
    { ticker: "BLDR", name: "Builders FirstSource Inc." },
    { ticker: "BLK", name: "BlackRock Inc." },
    { ticker: "BMY", name: "Bristol-Myers Squibb Company" },
    { ticker: "BR", name: "Broadridge Financial Solutions Inc." },
    { ticker: "BRK.B", name: "Berkshire Hathaway Inc." },
    { ticker: "BRO", name: "Brown & Brown Inc." },
    { ticker: "BSX", name: "Boston Scientific Corporation" },
    { ticker: "BWA", name: "BorgWarner Inc." },
    { ticker: "BX", name: "Blackstone Inc." },
    { ticker: "BXP", name: "Boston Properties Inc." },
    { ticker: "C", name: "Citigroup Inc." },
    { ticker: "CAG", name: "Conagra Brands Inc." },
    { ticker: "CAH", name: "Cardinal Health Inc." },
    { ticker: "CARR", name: "Carrier Global Corporation" },
    { ticker: "CAT", name: "Caterpillar Inc." },
    { ticker: "CB", name: "Chubb Limited" },
    { ticker: "CBOE", name: "Cboe Global Markets Inc." },
    { ticker: "CBRE", name: "CBRE Group Inc." },
    { ticker: "CCI", name: "Crown Castle Inc." },
    { ticker: "CCL", name: "Carnival Corporation & plc" },
    { ticker: "CDAY", name: "Ceridian HCM Holding Inc." },
    { ticker: "CDNS", name: "Cadence Design Systems Inc." },
    { ticker: "CDW", name: "CDW Corporation" },
    { ticker: "CE", name: "Celanese Corporation" },
    { ticker: "CEG", name: "Constellation Energy Corporation" },
    { ticker: "CF", name: "CF Industries Holdings Inc." },
    { ticker: "CFG", name: "Citizens Financial Group Inc." },
    { ticker: "CHD", name: "Church & Dwight Co. Inc." },
    { ticker: "CHRW", name: "C.H. Robinson Worldwide Inc." },
    { ticker: "CHTR", name: "Charter Communications Inc." },
    { ticker: "CI", name: "Cigna Corporation" },
    { ticker: "CINF", name: "Cincinnati Financial Corporation" },
    { ticker: "CL", name: "Colgate-Palmolive Company" },
    { ticker: "CLX", name: "The Clorox Company" },
    { ticker: "CMA", name: "Comerica Incorporated" },
    { ticker: "CMCSA", name: "Comcast Corporation" },
    { ticker: "CME", name: "CME Group Inc." },
    { ticker: "CMG", name: "Chipotle Mexican Grill Inc." },
    { ticker: "CMI", name: "Cummins Inc." },
    { ticker: "CMS", name: "CMS Energy Corporation" },
    { ticker: "CNC", name: "Centene Corporation" },
    { ticker: "CNP", name: "CenterPoint Energy Inc." },
    { ticker: "COF", name: "Capital One Financial Corporation" },
    { ticker: "COO", name: "The Cooper Companies Inc." },
    { ticker: "COP", name: "ConocoPhillips" },
    { ticker: "COR", name: "Cencora Inc." },
    { ticker: "COST", name: "Costco Wholesale Corporation" },
    { ticker: "COTY", name: "Coty Inc." },
    { ticker: "CPB", name: "Campbell Soup Company" },
    { ticker: "CPRT", name: "Copart Inc." },
    { ticker: "CPT", name: "Camden Property Trust" },
    { ticker: "CRL", name: "Charles River Laboratories International Inc." },
    { ticker: "CRM", name: "Salesforce Inc." },
    { ticker: "CRWD", name: "CrowdStrike Holdings Inc." },
    { ticker: "CSCO", name: "Cisco Systems Inc." },
    { ticker: "CSGP", name: "CoStar Group Inc." },
    { ticker: "CSX", name: "CSX Corporation" },
    { ticker: "CTAS", name: "Cintas Corporation" },
    { ticker: "CTLT", name: "Catalent Inc." },
    { ticker: "CTRA", name: "Coterra Energy Inc." },
    { ticker: "CTSH", name: "Cognizant Technology Solutions Corporation" },
    { ticker: "CTVA", name: "Corteva Inc." },
    { ticker: "CVS", name: "CVS Health Corporation" },
    { ticker: "CVX", name: "Chevron Corporation" },
    { ticker: "CZR", name: "Caesars Entertainment Inc." },
    { ticker: "D", name: "Dominion Energy Inc." },
    { ticker: "DAL", name: "Delta Air Lines Inc." },
    { ticker: "DAY", name: "Dayforce Inc." },
    { ticker: "DD", name: "DuPont de Nemours Inc." },
    { ticker: "DE", name: "Deere & Company" },
    { ticker: "DECK", name: "Deckers Outdoor Corporation" },
    { ticker: "DFS", name: "Discover Financial Services" },
    { ticker: "DG", name: "Dollar General Corporation" },
    { ticker: "DGX", name: "Quest Diagnostics Incorporated" },
    { ticker: "DHI", name: "D.R. Horton Inc." },
    { ticker: "DHR", name: "Danaher Corporation" },
    { ticker: "DIS", name: "The Walt Disney Company" },
    { ticker: "DLR", name: "Digital Realty Trust Inc." },
    { ticker: "DLTR", name: "Dollar Tree Inc." },
    { ticker: "DOV", name: "Dover Corporation" },
    { ticker: "DOW", name: "Dow Inc." },
    { ticker: "DPZ", name: "Domino's Pizza Inc." },
    { ticker: "DRI", name: "Darden Restaurants Inc." },
    { ticker: "DTE", name: "DTE Energy Company" },
    { ticker: "DUK", name: "Duke Energy Corporation" },
    { ticker: "DVA", name: "DaVita Inc." },
    { ticker: "DVN", name: "Devon Energy Corporation" },
    { ticker: "DXCM", name: "DexCom Inc." },
    { ticker: "EA", name: "Electronic Arts Inc." },
    { ticker: "EBAY", name: "eBay Inc." },
    { ticker: "ECL", name: "Ecolab Inc." },
    { ticker: "ED", name: "Consolidated Edison Inc." },
    { ticker: "EFX", name: "Equifax Inc." },
    { ticker: "EG", name: "Everest Group Ltd." },
    { ticker: "EIX", name: "Edison International" },
    { ticker: "EL", name: "The Estée Lauder Companies Inc." },
    { ticker: "ELV", name: "Elevance Health Inc." },
    { ticker: "EMN", name: "Eastman Chemical Company" },
    { ticker: "EMR", name: "Emerson Electric Co." },
    { ticker: "ENPH", name: "Enphase Energy Inc." },
    { ticker: "EOG", name: "EOG Resources Inc." },
    { ticker: "EPAM", name: "EPAM Systems Inc." },
    { ticker: "EQIX", name: "Equinix Inc." },
    { ticker: "EQR", name: "Equity Residential" },
    { ticker: "EQT", name: "EQT Corporation" },
    { ticker: "ES", name: "Eversource Energy" },
    { ticker: "ESS", name: "Essex Property Trust Inc." },
    { ticker: "ETN", name: "Eaton Corporation plc" },
    { ticker: "ETR", name: "Entergy Corporation" },
    { ticker: "ETSY", name: "Etsy Inc." },
    { ticker: "EVRG", name: "Evergy Inc." },
    { ticker: "EW", name: "Edwards Lifesciences Corporation" },
    { ticker: "EXC", name: "Exelon Corporation" },
    { ticker: "EXPD", name: "Expeditors International of Washington Inc." },
    { ticker: "EXPE", name: "Expedia Group Inc." },
    { ticker: "EXR", name: "Extended Stay America Inc." },
    { ticker: "F", name: "Ford Motor Company" },
    { ticker: "FANG", name: "Diamondback Energy Inc." },
    { ticker: "FAST", name: "Fastenal Company" },
    { ticker: "FCX", name: "Freeport-McMoRan Inc." },
    { ticker: "FDS", name: "FactSet Research Systems Inc." },
    { ticker: "FDX", name: "FedEx Corporation" },
    { ticker: "FE", name: "FirstEnergy Corp." },
    { ticker: "FFIV", name: "F5 Inc." },
    { ticker: "FI", name: "Fiserv Inc." },
    { ticker: "FICO", name: "Fair Isaac Corporation" },
    { ticker: "FIS", name: "Fidelity National Information Services Inc." },
    { ticker: "FITB", name: "Fifth Third Bancorp" },
    { ticker: "FLT", name: "FleetCor Technologies Inc." },
    { ticker: "FMC", name: "FMC Corporation" },
    { ticker: "FOX", name: "Fox Corporation" },
    { ticker: "FOXA", name: "Fox Corporation" },
    { ticker: "FRT", name: "Federal Realty Investment Trust" },
    { ticker: "FSLR", name: "First Solar Inc." },
    { ticker: "FTNT", name: "Fortinet Inc." },
    { ticker: "FTV", name: "Fortive Corporation" },
    { ticker: "GD", name: "General Dynamics Corporation" },
    { ticker: "GE", name: "General Electric Company" },
    { ticker: "GEHC", name: "GE HealthCare Technologies Inc." },
    { ticker: "GEN", name: "Gen Digital Inc." },
    { ticker: "GILD", name: "Gilead Sciences Inc." },
    { ticker: "GIS", name: "General Mills Inc." },
    { ticker: "GL", name: "Globe Life Inc." },
    { ticker: "GLW", name: "Corning Incorporated" },
    { ticker: "GM", name: "General Motors Company" },
    { ticker: "GNRC", name: "Generac Holdings Inc." },
    { ticker: "GOOG", name: "Alphabet Inc." },
    { ticker: "GOOGL", name: "Alphabet Inc." },
    { ticker: "GPC", name: "Genuine Parts Company" },
    { ticker: "GPN", name: "Global Payments Inc." },
    { ticker: "GRMN", name: "Garmin Ltd." },
    { ticker: "GS", name: "The Goldman Sachs Group Inc." },
    { ticker: "GWW", name: "W.W. Grainger Inc." },
    { ticker: "HAL", name: "Halliburton Company" },
    { ticker: "HAS", name: "Hasbro Inc." },
    { ticker: "HBAN", name: "Huntington Bancshares Incorporated" },
    { ticker: "HCA", name: "HCA Healthcare Inc." },
    { ticker: "HD", name: "The Home Depot Inc." },
    { ticker: "HES", name: "Hess Corporation" },
    { ticker: "HIG", name: "The Hartford Financial Services Group Inc." },
    { ticker: "HII", name: "Huntington Ingalls Industries Inc." },
    { ticker: "HLT", name: "Hilton Worldwide Holdings Inc." },
    { ticker: "HOLX", name: "Hologic Inc." },
    { ticker: "HON", name: "Honeywell International Inc." },
    { ticker: "HPE", name: "Hewlett Packard Enterprise Company" },
    { ticker: "HPQ", name: "HP Inc." },
    { ticker: "HRL", name: "Hormel Foods Corporation" },
    { ticker: "HSIC", name: "Henry Schein Inc." },
    { ticker: "HST", name: "Host Hotels & Resorts Inc." },
    { ticker: "HSY", name: "The Hershey Company" },
    { ticker: "HUBB", name: "Hubbell Incorporated" },
    { ticker: "HUM", name: "Humana Inc." },
    { ticker: "HWM", name: "Howmet Aerospace Inc." },
    { ticker: "IBM", name: "International Business Machines Corporation" },
    { ticker: "ICE", name: "Intercontinental Exchange Inc." },
    { ticker: "IDXX", name: "IDEXX Laboratories Inc." },
    { ticker: "IEX", name: "IDEX Corporation" },
    { ticker: "IFF", name: "International Flavors & Fragrances Inc." },
    { ticker: "IFS", name: "Infinera Corporation" },
    { ticker: "ILMN", name: "Illumina Inc." },
    { ticker: "INCY", name: "Incyte Corporation" },
    { ticker: "INTC", name: "Intel Corporation" },
    { ticker: "INTU", name: "Intuit Inc." },
    { ticker: "INVH", name: "Invitation Homes Inc." },
    { ticker: "IP", name: "International Paper Company" },
    { ticker: "IPG", name: "The Interpublic Group of Companies Inc." },
    { ticker: "IQV", name: "IQVIA Holdings Inc." },
    { ticker: "IR", name: "Ingersoll Rand Inc." },
    { ticker: "IRM", name: "Iron Mountain Incorporated" },
    { ticker: "ISRG", name: "Intuitive Surgical Inc." },
    { ticker: "IT", name: "Gartner Inc." },
    { ticker: "ITW", name: "Illinois Tool Works Inc." },
    { ticker: "IVZ", name: "Invesco Ltd." },
    { ticker: "J", name: "Jacobs Engineering Group Inc." },
    { ticker: "JBHT", name: "J.B. Hunt Transport Services Inc." },
    { ticker: "JBL", name: "Jabil Inc." },
    { ticker: "JCI", name: "Johnson Controls International plc" },
    { ticker: "JKHY", name: "Jack Henry & Associates Inc." },
    { ticker: "JNJ", name: "Johnson & Johnson" },
    { ticker: "JNPR", name: "Juniper Networks Inc." },
    { ticker: "JPM", name: "JPMorgan Chase & Co." },
    { ticker: "K", name: "Kellogg Company" },
    { ticker: "KDP", name: "Keurig Dr Pepper Inc." },
    { ticker: "KEY", name: "KeyCorp" },
    { ticker: "KEYS", name: "Keysight Technologies Inc." },
    { ticker: "KHC", name: "The Kraft Heinz Company" },
    { ticker: "KIM", name: "Kimco Realty Corporation" },
    { ticker: "KLAC", name: "KLA Corporation" },
    { ticker: "KMB", name: "Kimberly-Clark Corporation" },
    { ticker: "KMI", name: "Kinder Morgan Inc." },
    { ticker: "KMX", name: "CarMax Inc." },
    { ticker: "KO", name: "The Coca-Cola Company" },
    { ticker: "KR", name: "The Kroger Co." },
    { ticker: "KVUE", name: "Kenvue Inc." },
    { ticker: "L", name: "Loews Corporation" },
    { ticker: "LDOS", name: "Leidos Holdings Inc." },
    { ticker: "LEN", name: "Lennar Corporation" },
    { ticker: "LH", name: "Laboratory Corporation of America Holdings" },
    { ticker: "LHX", name: "L3Harris Technologies Inc." },
    { ticker: "LIN", name: "Linde plc" },
    { ticker: "LKQ", name: "LKQ Corporation" },
    { ticker: "LLY", name: "Eli Lilly and Company" },
    { ticker: "LMT", name: "Lockheed Martin Corporation" },
    { ticker: "LNT", name: "Alliant Energy Corporation" },
    { ticker: "LOW", name: "Lowe's Companies Inc." },
    { ticker: "LRCX", name: "Lam Research Corporation" },
    { ticker: "LULU", name: "Lululemon Athletica Inc." },
    { ticker: "LUV", name: "Southwest Airlines Co." },
    { ticker: "LVS", name: "Las Vegas Sands Corp." },
    { ticker: "LW", name: "Lamb Weston Holdings Inc." },
    { ticker: "LYB", name: "LyondellBasell Industries N.V." },
    { ticker: "LYV", name: "Live Nation Entertainment Inc." },
    { ticker: "MA", name: "Mastercard Incorporated" },
    { ticker: "MAA", name: "Mid-America Apartment Communities Inc." },
    { ticker: "MAR", name: "Marriott International Inc." },
    { ticker: "MAS", name: "Masco Corporation" },
    { ticker: "MCD", name: "McDonald's Corporation" },
    { ticker: "MCHP", name: "Microchip Technology Incorporated" },
    { ticker: "MCK", name: "McKesson Corporation" },
    { ticker: "MCO", name: "Moody's Corporation" },
    { ticker: "MDLZ", name: "Mondelez International Inc." },
    { ticker: "MDT", name: "Medtronic plc" },
    { ticker: "MET", name: "MetLife Inc." },
    { ticker: "META", name: "Meta Platforms Inc." },
    { ticker: "MGM", name: "MGM Resorts International" },
    { ticker: "MHK", name: "Mohawk Industries Inc." },
    { ticker: "MKC", name: "McCormick & Company Incorporated" },
    { ticker: "MKTX", name: "MarketAxess Holdings Inc." },
    { ticker: "MLM", name: "Martin Marietta Materials Inc." },
    { ticker: "MMC", name: "Marsh & McLennan Companies Inc." },
    { ticker: "MMM", name: "3M Company" },
    { ticker: "MNST", name: "Monster Beverage Corporation" },
    { ticker: "MO", name: "Altria Group Inc." },
    { ticker: "MOH", name: "Molina Healthcare Inc." },
    { ticker: "MOS", name: "The Mosaic Company" },
    { ticker: "MPC", name: "Marathon Petroleum Corporation" },
    { ticker: "MPWR", name: "Monolithic Power Systems Inc." },
    { ticker: "MRK", name: "Merck & Co. Inc." },
    { ticker: "MRNA", name: "Moderna Inc." },
    { ticker: "MRO", name: "Marathon Oil Corporation" },
    { ticker: "MS", name: "Morgan Stanley" },
    { ticker: "MSCI", name: "MSCI Inc." },
    { ticker: "MSFT", name: "Microsoft Corporation" },
    { ticker: "MSI", name: "Motorola Solutions Inc." },
    { ticker: "MTB", name: "M&T Bank Corporation" },
    { ticker: "MTCH", name: "Match Group Inc." },
    { ticker: "MTD", name: "Mettler-Toledo International Inc." },
    { ticker: "MU", name: "Micron Technology Inc." },
    { ticker: "NCLH", name: "Norwegian Cruise Line Holdings Ltd." },
    { ticker: "NDAQ", name: "Nasdaq Inc." },
    { ticker: "NDSN", name: "Nordson Corporation" },
    { ticker: "NEE", name: "NextEra Energy Inc." },
    { ticker: "NEM", name: "Newmont Corporation" },
    { ticker: "NFLX", name: "Netflix Inc." },
    { ticker: "NI", name: "NiSource Inc." },
    { ticker: "NKE", name: "NIKE Inc." },
    { ticker: "NOC", name: "Northrop Grumman Corporation" },
    { ticker: "NOW", name: "ServiceNow Inc." },
    { ticker: "NRG", name: "NRG Energy Inc." },
    { ticker: "NSC", name: "Norfolk Southern Corporation" },
    { ticker: "NTAP", name: "NetApp Inc." },
    { ticker: "NTRS", name: "Northern Trust Corporation" },
    { ticker: "NUE", name: "Nucor Corporation" },
    { ticker: "NVDA", name: "NVIDIA Corporation" },
    { ticker: "NVR", name: "NVR Inc." },
    { ticker: "NWS", name: "News Corporation" },
    { ticker: "NWSA", name: "News Corporation" },
    { ticker: "NXPI", name: "NXP Semiconductors N.V." },
    { ticker: "O", name: "Realty Income Corporation" },
    { ticker: "ODFL", name: "Old Dominion Freight Line Inc." },
    { ticker: "OKE", name: "ONEOK Inc." },
    { ticker: "OMC", name: "Omnicom Group Inc." },
    { ticker: "ON", name: "ON Semiconductor Corporation" },
    { ticker: "ORCL", name: "Oracle Corporation" },
    { ticker: "ORLY", name: "O'Reilly Automotive Inc." },
    { ticker: "OTIS", name: "Otis Worldwide Corporation" },
    { ticker: "OXY", name: "Occidental Petroleum Corporation" },
    { ticker: "PANW", name: "Palo Alto Networks Inc." },
    { ticker: "PARA", name: "Paramount Global" },
    { ticker: "PAYC", name: "Paycom Software Inc." },
    { ticker: "PAYX", name: "Paychex Inc." },
    { ticker: "PCAR", name: "PACCAR Inc." },
    { ticker: "PCG", name: "PG&E Corporation" },
    { ticker: "PEAK", name: "Healthpeak Properties Inc." },
    { ticker: "PEG", name: "Public Service Enterprise Group Incorporated" },
    { ticker: "PEP", name: "PepsiCo Inc." },
    { ticker: "PFE", name: "Pfizer Inc." },
    { ticker: "PFG", name: "Principal Financial Group Inc." },
    { ticker: "PG", name: "The Procter & Gamble Company" },
    { ticker: "PGR", name: "The Progressive Corporation" },
    { ticker: "PH", name: "Parker-Hannifin Corporation" },
    { ticker: "PHM", name: "PulteGroup Inc." },
    { ticker: "PKG", name: "Packaging Corporation of America" },
    { ticker: "PKI", name: "PerkinElmer Inc." },
    { ticker: "PLD", name: "Prologis Inc." },
    { ticker: "PM", name: "Philip Morris International Inc." },
    { ticker: "PNC", name: "The PNC Financial Services Group Inc." },
    { ticker: "PNR", name: "Pentair plc" },
    { ticker: "PNW", name: "Pinnacle West Capital Corporation" },
    { ticker: "PODD", name: "Insulet Corporation" },
    { ticker: "POOL", name: "Pool Corporation" },
    { ticker: "PPG", name: "PPG Industries Inc." },
    { ticker: "PPL", name: "PPL Corporation" },
    { ticker: "PRU", name: "Prudential Financial Inc." },
    { ticker: "PSA", name: "Public Storage" },
    { ticker: "PSX", name: "Phillips 66" },
    { ticker: "PTC", name: "PTC Inc." },
    { ticker: "PWR", name: "Quanta Services Inc." },
    { ticker: "PXD", name: "Pioneer Natural Resources Company" },
    { ticker: "PYPL", name: "PayPal Holdings Inc." },
    { ticker: "QCOM", name: "QUALCOMM Incorporated" },
    { ticker: "QRVO", name: "Qorvo Inc." },
    { ticker: "RCL", name: "Royal Caribbean Cruises Ltd." },
    { ticker: "REG", name: "Regency Centers Corporation" },
    { ticker: "REGN", name: "Regeneron Pharmaceuticals Inc." },
    { ticker: "RF", name: "Regions Financial Corporation" },
    { ticker: "RHI", name: "Robert Half Inc." },
    { ticker: "RJF", name: "Raymond James Financial Inc." },
    { ticker: "RL", name: "Ralph Lauren Corporation" },
    { ticker: "RMD", name: "ResMed Inc." },
    { ticker: "ROK", name: "Rockwell Automation Inc." },
    { ticker: "ROL", name: "Rollins Inc." },
    { ticker: "ROP", name: "Roper Technologies Inc." },
    { ticker: "ROST", name: "Ross Stores Inc." },
    { ticker: "RSG", name: "Republic Services Inc." },
    { ticker: "RTX", name: "Raytheon Technologies Corporation" },
    { ticker: "RVTY", name: "Revvity Inc." },
    { ticker: "SBAC", name: "SBA Communications Corporation" },
    { ticker: "SBUX", name: "Starbucks Corporation" },
    { ticker: "SCHW", name: "The Charles Schwab Corporation" },
    { ticker: "SHW", name: "The Sherwin-Williams Company" },
    { ticker: "SJM", name: "The J.M. Smucker Company" },
    { ticker: "SLB", name: "Schlumberger Limited" },
    { ticker: "SNA", name: "Snap-on Incorporated" },
    { ticker: "SNPS", name: "Synopsys Inc." },
    { ticker: "SO", name: "The Southern Company" },
    { ticker: "SPG", name: "Simon Property Group Inc." },
    { ticker: "SPGI", name: "S&P Global Inc." },
    { ticker: "SRE", name: "Sempra Energy" },
    { ticker: "STE", name: "STERIS plc" },
    { ticker: "STT", name: "State Street Corporation" },
    { ticker: "STX", name: "Seagate Technology Holdings plc" },
    { ticker: "STZ", name: "Constellation Brands Inc." },
    { ticker: "SWK", name: "Stanley Black & Decker Inc." },
    { ticker: "SWKS", name: "Skyworks Solutions Inc." },
    { ticker: "SYF", name: "Synchrony Financial" },
    { ticker: "SYK", name: "Stryker Corporation" },
    { ticker: "SYY", name: "Sysco Corporation" },
    { ticker: "T", name: "AT&T Inc." },
    { ticker: "TAP", name: "Molson Coors Beverage Company" },
    { ticker: "TDG", name: "TransDigm Group Incorporated" },
    { ticker: "TDY", name: "Teledyne Technologies Incorporated" },
    { ticker: "TECH", name: "Bio-Techne Corporation" },
    { ticker: "TEL", name: "TE Connectivity Ltd." },
    { ticker: "TER", name: "Teradyne Inc." },
    { ticker: "TFC", name: "Truist Financial Corporation" },
    { ticker: "TFX", name: "Teleflex Incorporated" },
    { ticker: "TGT", name: "Target Corporation" },
    { ticker: "TJX", name: "The TJX Companies Inc." },
    { ticker: "TMO", name: "Thermo Fisher Scientific Inc." },
    { ticker: "TMUS", name: "T-Mobile US Inc." },
    { ticker: "TPG", name: "Texas Pacific Group Inc." },
    { ticker: "TPR", name: "Tapestry Inc." },
    { ticker: "TRGP", name: "Targa Resources Corp." },
    { ticker: "TRMB", name: "Trimble Inc." },
    { ticker: "TROW", name: "T. Rowe Price Group Inc." },
    { ticker: "TRV", name: "The Travelers Companies Inc." },
    { ticker: "TSCO", name: "Tractor Supply Company" },
    { ticker: "TSLA", name: "Tesla Inc." },
    { ticker: "TSN", name: "Tyson Foods Inc." },
    { ticker: "TT", name: "Trane Technologies plc" },
    { ticker: "TTWO", name: "Take-Two Interactive Software Inc." },
    { ticker: "TXN", name: "Texas Instruments Incorporated" },
    { ticker: "TXT", name: "Textron Inc." },
    { ticker: "TYL", name: "Tyler Technologies Inc." },
    { ticker: "UAL", name: "United Airlines Holdings Inc." },
    { ticker: "UBER", name: "Uber Technologies Inc." },
    { ticker: "UDR", name: "UDR Inc." },
    { ticker: "UHS", name: "Universal Health Services Inc." },
    { ticker: "ULTA", name: "Ulta Beauty Inc." },
    { ticker: "UNH", name: "UnitedHealth Group Incorporated" },
    { ticker: "UNP", name: "Union Pacific Corporation" },
    { ticker: "UPS", name: "United Parcel Service Inc." },
    { ticker: "URI", name: "United Rentals Inc." },
    { ticker: "USB", name: "U.S. Bancorp" },
    { ticker: "V", name: "Visa Inc." },
    { ticker: "VFC", name: "V.F. Corporation" },
    { ticker: "VICI", name: "VICI Properties Inc." },
    { ticker: "VLO", name: "Valero Energy Corporation" },
    { ticker: "VLTO", name: "Veralto Corporation" },
    { ticker: "VMC", name: "Vulcan Materials Company" },
    { ticker: "VNO", name: "Vornado Realty Trust" },
    { ticker: "VRSK", name: "Verisk Analytics Inc." },
    { ticker: "VRSN", name: "VeriSign Inc." },
    { ticker: "VRTX", name: "Vertex Pharmaceuticals Incorporated" },
    { ticker: "VTR", name: "Ventas Inc." },
    { ticker: "VTRS", name: "Viatris Inc." },
    { ticker: "VZ", name: "Verizon Communications Inc." },
    { ticker: "WAB", name: "Westinghouse Air Brake Technologies Corporation" },
    { ticker: "WAT", name: "Waters Corporation" },
    { ticker: "WBA", name: "Walgreens Boots Alliance Inc." },
    { ticker: "WBD", name: "Warner Bros. Discovery Inc." },
    { ticker: "WDC", name: "Western Digital Corporation" },
    { ticker: "WEC", name: "WEC Energy Group Inc." },
    { ticker: "WELL", name: "Welltower Inc." },
    { ticker: "WFC", name: "Wells Fargo & Company" },
    { ticker: "WHR", name: "Whirlpool Corporation" },
    { ticker: "WM", name: "Waste Management Inc." },
    { ticker: "WMB", name: "The Williams Companies Inc." },
    { ticker: "WMT", name: "Walmart Inc." },
    { ticker: "WRB", name: "W. R. Berkley Corporation" },
    { ticker: "WRK", name: "WestRock Company" },
    { ticker: "WST", name: "West Pharmaceutical Services Inc." },
    { ticker: "WTW", name: "Willis Towers Watson Public Limited Company" },
    { ticker: "WY", name: "Weyerhaeuser Company" },
    { ticker: "WYNN", name: "Wynn Resorts Limited" },
    { ticker: "XEL", name: "Xcel Energy Inc." },
    { ticker: "XOM", name: "Exxon Mobil Corporation" },
    { ticker: "XRAY", name: "DENTSPLY SIRONA Inc." },
    { ticker: "XYL", name: "Xylem Inc." },
    { ticker: "YUM", name: "Yum! Brands Inc." },
    { ticker: "ZBH", name: "Zimmer Biomet Holdings Inc." },
    { ticker: "ZBRA", name: "Zebra Technologies Corporation" },
    { ticker: "ZION", name: "Zions Bancorporation N.A." },
    { ticker: "ZTS", name: "Zoetis Inc." }
];

/**
 * Initialize auto-complete functionality for a stock ticker input field
 * @param {string} inputElementId - The ID of the input element to attach auto-complete to
 * @param {Object} options - Configuration options
 * @param {number} options.maxSuggestions - Maximum number of suggestions to show (default: 10)
 * @param {string} options.suggestionBoxId - ID for the suggestion box (default: inputElementId + '-suggestions')
 * @param {Function} options.onSelection - Callback function called when a suggestion is selected (ticker, matchObject) => void
 */
function initStockAutocomplete(inputElementId, options = {}) {
    const inputElement = document.getElementById(inputElementId);
    if (!inputElement) {
        console.warn(`Stock autocomplete: Input element with ID '${inputElementId}' not found`);
        return null; // Return null if element not found
    }

    const config = {
        maxSuggestions: options.maxSuggestions || 10,
        suggestionBoxId: options.suggestionBoxId || (inputElementId + '-suggestions'),
        ...options
    };

    // Create the suggestion box
    const suggestionBox = document.createElement('div');
    suggestionBox.id = config.suggestionBoxId;
    suggestionBox.style.position = 'absolute';
    suggestionBox.style.background = '#fff';
    suggestionBox.style.border = '1px solid #ccc';
    suggestionBox.style.borderRadius = '4px';
    suggestionBox.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
    suggestionBox.style.zIndex = '1000';
    suggestionBox.style.display = 'none';
    suggestionBox.style.maxHeight = '180px';
    suggestionBox.style.overflowY = 'auto';
    suggestionBox.style.fontSize = '14px';
    
    // Insert suggestion box after the input element
    inputElement.parentNode.insertBefore(suggestionBox, inputElement.nextSibling);

    // --- Event Handlers ---
    // We store references to handlers to properly remove them later
    const handlers = {};

    // Position the suggestion box below the input
    handlers.positionSuggestionBox = function() {
        const rect = inputElement.getBoundingClientRect();
        suggestionBox.style.top = (inputElement.offsetTop + inputElement.offsetHeight) + 'px';
        suggestionBox.style.left = inputElement.offsetLeft + 'px';
        suggestionBox.style.width = inputElement.offsetWidth + 'px';
    }

    // Show suggestions as user types
    handlers.onInput = function() {
        const value = inputElement.value.trim().toUpperCase();
        if (!value) {
            suggestionBox.style.display = 'none';
            return;
        }

        const matches = TICKER_LIST.filter(item =>
            item.ticker.startsWith(value) || item.name.toUpperCase().includes(value)
        ).slice(0, config.maxSuggestions);

        if (matches.length === 0) {
            suggestionBox.style.display = 'none';
            return;
        }

        suggestionBox.innerHTML = matches.map(item =>
            `<div class="ticker-suggestion" style="padding:8px;cursor:pointer;border-bottom:1px solid #eee;" 
                  onmouseover="this.style.backgroundColor='#f5f5f5'" 
                  onmouseout="this.style.backgroundColor='white'">
                <span style="font-weight:bold;color:#2563eb;">${item.ticker}</span> 
                <span style="color:#666;margin-left:8px;">${item.name}</span>
            </div>`
        ).join('');

        suggestionBox.style.display = 'block';
        handlers.positionSuggestionBox();
        
        // Store the matches for click handler
        suggestionBox._matches = matches;
    };

    // Handle click on suggestion
    handlers.onSuggestionClick = function(e) {
        const target = e.target.closest('.ticker-suggestion');
        if (target) {
            const idx = Array.from(suggestionBox.children).indexOf(target);
            const match = suggestionBox._matches && suggestionBox._matches[idx];
            if (match) {
                inputElement.value = match.ticker;
                const event = new Event('input', { bubbles: true });
                inputElement.dispatchEvent(event);
                
                if (options.onSelection && typeof options.onSelection === 'function') {
                    options.onSelection(match.ticker, match);
                }
            }
            suggestionBox.style.display = 'none';
            inputElement.focus();
        }
    };

    // Hide suggestions on blur
    handlers.onBlur = function() {
        setTimeout(() => { 
            suggestionBox.style.display = 'none'; 
        }, 150);
    };

    // Hide suggestions on Escape key
    handlers.onKeyDown = function(e) {
        if (e.key === 'Escape') {
            suggestionBox.style.display = 'none';
        }
    };

    // --- Attach Event Listeners ---
    window.addEventListener('resize', handlers.positionSuggestionBox);
    inputElement.addEventListener('focus', handlers.positionSuggestionBox);
    inputElement.addEventListener('input', handlers.onInput);
    suggestionBox.addEventListener('mousedown', handlers.onSuggestionClick);
    inputElement.addEventListener('blur', handlers.onBlur);
    inputElement.addEventListener('keydown', handlers.onKeyDown);

    return {
        suggestionBox,
        destroy: function() {
            // Remove all event listeners
            window.removeEventListener('resize', handlers.positionSuggestionBox);
            inputElement.removeEventListener('focus', handlers.positionSuggestionBox);
            inputElement.removeEventListener('input', handlers.onInput);
            suggestionBox.removeEventListener('mousedown', handlers.onSuggestionClick);
            inputElement.removeEventListener('blur', handlers.onBlur);
            inputElement.removeEventListener('keydown', handlers.onKeyDown);

            // Remove the suggestion box from the DOM
            if (suggestionBox.parentNode) {
                suggestionBox.parentNode.removeChild(suggestionBox);
            }
/*console.log(`Autocomplete for '${inputElementId}' destroyed.`);*/ 
        }
    };
}

// Export for use in other modules (if using modules)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initStockAutocomplete, TICKER_LIST };
}

// Also make available globally
window.initStockAutocomplete = initStockAutocomplete;
window.TICKER_LIST = TICKER_LIST;
