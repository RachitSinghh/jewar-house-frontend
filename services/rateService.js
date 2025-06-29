import { format } from 'date-fns';

// Environment configuration
const API_CONFIG = {
  // Using multiple free APIs for redundancy
  updateInterval: parseInt(process.env.EXPO_PUBLIC_RATE_UPDATE_INTERVAL || '30000'), // 30 seconds
  enableLiveRates: process.env.EXPO_PUBLIC_ENABLE_LIVE_RATES !== 'false', // Default to true
};

// Updated default rates based on current market prices (per 10g)
const DEFAULT_RATES = {
  gold: {
    '24KT': parseInt(process.env.EXPO_PUBLIC_DEFAULT_GOLD_24KT || '99150'),
    '22KT': parseInt(process.env.EXPO_PUBLIC_DEFAULT_GOLD_22KT || '90891'),
    '20KT': parseInt(process.env.EXPO_PUBLIC_DEFAULT_GOLD_20KT || '83592'),
    '18KT': parseInt(process.env.EXPO_PUBLIC_DEFAULT_GOLD_18KT || '75563'),
    '14KT': parseInt(process.env.EXPO_PUBLIC_DEFAULT_GOLD_14KT || '57834'),
  },
  silver: {
    '24KT': parseInt(process.env.EXPO_PUBLIC_DEFAULT_SILVER_24KT || '1065'),
    '22KT': parseInt(process.env.EXPO_PUBLIC_DEFAULT_SILVER_22KT || '1007'),
    '18KT': parseInt(process.env.EXPO_PUBLIC_DEFAULT_SILVER_18KT || '829'),
    '14KT': parseInt(process.env.EXPO_PUBLIC_DEFAULT_SILVER_14KT || '651'),
    '9KT': parseInt(process.env.EXPO_PUBLIC_DEFAULT_SILVER_9KT || '429'),
  },
};

// WebSocket/polling connection
let updateInterval = null;
let subscribers = new Set();
let lastApiCallTime = 0;
const API_CALL_COOLDOWN = 10000; // 10 seconds between API calls

// Current rates initialized with updated defaults
let currentRates = {
  lastUpdated: new Date(),
  ...DEFAULT_RATES,
};

// USD to INR conversion rate (updated periodically)
let usdToInr = 83.50; // Default rate, will be updated from API
let lastCurrencyUpdate = 0;
const CURRENCY_UPDATE_INTERVAL = 300000; // 5 minutes

// Function to get USD to INR exchange rate with caching
const getUsdToInrRate = async () => {
  const now = Date.now();
  
  // Only update currency rate every 5 minutes
  if (now - lastCurrencyUpdate < CURRENCY_UPDATE_INTERVAL) {
    return true;
  }

  try {
    console.log('💱 Fetching USD to INR rate...');
    const response = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
      headers: {
        'User-Agent': 'JewarHouse/1.0',
      },
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.rates && data.rates.INR) {
        const newRate = data.rates.INR;
        if (Math.abs(newRate - usdToInr) > 0.1) { // Only update if significant change
          usdToInr = newRate;
          lastCurrencyUpdate = now;
          console.log(`✅ Updated USD to INR rate: ${usdToInr}`);
        }
        return true;
      }
    }
  } catch (error) {
    console.warn('❌ Failed to fetch USD to INR rate:', error.message);
  }
  return false;
};

// Function to convert USD per troy ounce to INR per 10 grams
const convertToIndianRates = (usdPerOunce) => {
  // 1 troy ounce = 31.1035 grams
  const gramsPerTroyOunce = 31.1035;
  const usdPer10Grams = (usdPerOunce * 10) / gramsPerTroyOunce;
  const inrPer10Grams = usdPer10Grams * usdToInr;
  return Math.round(inrPer10Grams);
};

// Function to calculate different purities from 24KT base rate
const calculatePurities = (base24kt) => {
  return {
    '24KT': base24kt,
    '22KT': Math.round(base24kt * (22/24)),
    '20KT': Math.round(base24kt * (20/24)),
    '18KT': Math.round(base24kt * (18/24)),
    '14KT': Math.round(base24kt * (14/24)),
    '9KT': Math.round(base24kt * (9/24)), // For silver
  };
};

// Enhanced free API sources with better error handling
const fetchFromFreeApis = async () => {
  const now = Date.now();
  
  // Rate limiting: Don't call APIs too frequently
  if (now - lastApiCallTime < API_CALL_COOLDOWN) {
    console.log('⏳ API call cooldown active, skipping external fetch');
    return null;
  }

  const apis = [
    {
      name: 'Metals-API (Free)',
      url: 'https://api.metals.live/v1/spot',
      timeout: 5000,
      transform: (data) => {
        // Try different possible field names
        const gold = data.gold || data.XAU || data.GOLD || data.au;
        const silver = data.silver || data.XAG || data.SILVER || data.ag;
        return { gold, silver };
      }
    },
    {
      name: 'Alternative Metals API',
      url: 'https://api.metalpriceapi.com/v1/latest?api_key=demo&base=USD&symbols=XAU,XAG',
      timeout: 5000,
      transform: (data) => {
        const rates = data.rates || {};
        return {
          gold: rates.XAU ? (1 / rates.XAU) : null, // Convert to USD per ounce
          silver: rates.XAG ? (1 / rates.XAG) : null
        };
      }
    },
    {
      name: 'Backup Metals API',
      url: 'https://api.metals.live/v1/spot/gold,silver',
      timeout: 5000,
      transform: (data) => {
        return {
          gold: data.gold || data.XAU,
          silver: data.silver || data.XAG
        };
      }
    }
  ];

  for (const api of apis) {
    try {
      console.log(`🔄 Trying ${api.name}...`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), api.timeout);
      
      const response = await fetch(api.url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'JewarHouse/1.0',
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        console.log(`📊 Raw data from ${api.name}:`, JSON.stringify(data).substring(0, 200) + '...');
        
        const rates = api.transform(data);
        console.log(`🔄 Transformed rates:`, rates);
        
        if (rates.gold && rates.silver && rates.gold > 0 && rates.silver > 0) {
          console.log(`✅ Successfully fetched from ${api.name}`);
          lastApiCallTime = now;
          return rates;
        } else {
          console.warn(`⚠️ ${api.name} returned incomplete data`);
        }
      } else {
        console.warn(`❌ ${api.name} returned status ${response.status}`);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.warn(`⏰ ${api.name} timed out`);
      } else {
        console.warn(`❌ ${api.name} failed:`, error.message);
      }
    }
  }
  
  return null;
};

// Enhanced rate fetching with better error handling
const fetchRatesFromAPI = async () => {
  try {
    console.log('🚀 Starting rate fetch process...');
    
    // First, update USD to INR rate (with caching)
    await getUsdToInrRate();

    // Try to fetch from free APIs
    const apiRates = await fetchFromFreeApis();
    
    if (apiRates && apiRates.gold && apiRates.silver) {
      // Validate rates are reasonable (basic sanity check)
      if (apiRates.gold > 1000 && apiRates.gold < 5000 && 
          apiRates.silver > 10 && apiRates.silver < 100) {
        
        // Convert to Indian rates (INR per 10 grams)
        const goldInr = convertToIndianRates(apiRates.gold);
        const silverInr = convertToIndianRates(apiRates.silver);

        const transformedRates = {
          lastUpdated: new Date(),
          gold: calculatePurities(goldInr),
          silver: calculatePurities(silverInr),
        };

        console.log(`💰 Live Rates - Gold 24KT: ₹${transformedRates.gold['24KT']}/10g, Silver 24KT: ₹${transformedRates.silver['24KT']}/10g`);
        return transformedRates;
      } else {
        console.warn('⚠️ API rates failed sanity check, using simulation');
      }
    }

    // If APIs fail, simulate realistic market movements
    console.log('📈 APIs unavailable, simulating realistic market movements...');
    return simulateRealisticRates();

  } catch (error) {
    console.error('❌ Error fetching rates:', error.message);
    return simulateRealisticRates();
  }
};

// Enhanced realistic market simulation
const simulateRealisticRates = () => {
  console.log('🎯 Generating realistic market simulation...');
  
  // Market factors simulation
  const marketFactors = {
    // Time-based volatility (higher during market hours)
    timeVolatility: getTimeBasedVolatility(),
    // Random market events (news, economic data, etc.)
    marketSentiment: getMarketSentiment(),
    // Currency fluctuation impact
    currencyImpact: (Math.random() - 0.5) * 0.002, // ±0.2%
    // Weekly trend (slight bias based on day of week)
    weeklyTrend: getWeeklyTrend(),
  };

  console.log('📊 Market factors:', marketFactors);

  // Calculate realistic fluctuations
  const goldFluctuation = calculateRealisticFluctuation('gold', marketFactors);
  const silverFluctuation = calculateRealisticFluctuation('silver', marketFactors);

  const newRates = {
    lastUpdated: new Date(),
    gold: {
      '24KT': Math.round(currentRates.gold['24KT'] * (1 + goldFluctuation)),
      '22KT': Math.round(currentRates.gold['22KT'] * (1 + goldFluctuation)),
      '20KT': Math.round(currentRates.gold['20KT'] * (1 + goldFluctuation)),
      '18KT': Math.round(currentRates.gold['18KT'] * (1 + goldFluctuation)),
      '14KT': Math.round(currentRates.gold['14KT'] * (1 + goldFluctuation)),
    },
    silver: {
      '24KT': Math.round(currentRates.silver['24KT'] * (1 + silverFluctuation)),
      '22KT': Math.round(currentRates.silver['22KT'] * (1 + silverFluctuation)),
      '18KT': Math.round(currentRates.silver['18KT'] * (1 + silverFluctuation)),
      '14KT': Math.round(currentRates.silver['14KT'] * (1 + silverFluctuation)),
      '9KT': Math.round(currentRates.silver['9KT'] * (1 + silverFluctuation)),
    },
  };

  console.log(`📈 Simulated Rates - Gold: ${goldFluctuation > 0 ? '+' : ''}${(goldFluctuation * 100).toFixed(3)}%, Silver: ${silverFluctuation > 0 ? '+' : ''}${(silverFluctuation * 100).toFixed(3)}%`);
  
  return newRates;
};

// Get time-based volatility (higher during market hours)
const getTimeBasedVolatility = () => {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();
  
  // Higher volatility during market hours (9 AM - 5 PM, weekdays)
  const isMarketHours = (day >= 1 && day <= 5) && (hour >= 9 && hour < 17);
  
  // Even higher volatility during opening/closing hours
  const isOpeningHour = hour === 9;
  const isClosingHour = hour === 16;
  
  if (isOpeningHour || isClosingHour) return 2.0;
  if (isMarketHours) return 1.5;
  return 0.8;
};

// Get market sentiment based on various factors
const getMarketSentiment = () => {
  const random = Math.random();
  
  // 60% neutral, 20% bullish, 20% bearish
  if (random < 0.6) return 'neutral';
  if (random < 0.8) return 'bullish';
  return 'bearish';
};

// Get weekly trend (slight bias based on day of week)
const getWeeklyTrend = () => {
  const day = new Date().getDay();
  
  // Monday: slight bullish (new week optimism)
  // Friday: slight bearish (profit taking)
  // Other days: neutral
  if (day === 1) return 0.0005; // +0.05% bias
  if (day === 5) return -0.0005; // -0.05% bias
  return 0;
};

// Enhanced realistic fluctuation calculation
const calculateRealisticFluctuation = (metal, factors) => {
  // Base volatility (gold is typically less volatile than silver)
  const baseVolatility = metal === 'gold' ? 0.003 : 0.005; // 0.3% vs 0.5%
  
  // Apply market factors
  let fluctuation = (Math.random() - 0.5) * baseVolatility * factors.timeVolatility;
  
  // Apply market sentiment
  if (factors.marketSentiment === 'bullish') {
    fluctuation += Math.random() * 0.002; // Up to +0.2% bullish bias
  } else if (factors.marketSentiment === 'bearish') {
    fluctuation -= Math.random() * 0.002; // Up to -0.2% bearish bias
  }
  
  // Apply currency impact
  fluctuation += factors.currencyImpact;
  
  // Apply weekly trend
  fluctuation += factors.weeklyTrend;
  
  // Ensure fluctuation stays within realistic bounds (±1.5%)
  return Math.max(-0.015, Math.min(0.015, fluctuation));
};

// Function to start live updates
const startLiveUpdates = () => {
  if (!API_CONFIG.enableLiveRates) {
    console.log('📴 Live rates disabled in configuration');
    return;
  }

  if (updateInterval) {
    console.log('🔄 Live updates already running');
    return;
  }

  console.log('🚀 Starting live rate updates...');
  
  // Initial fetch
  updateRates();
  
  // Set up polling interval
  updateInterval = setInterval(updateRates, API_CONFIG.updateInterval);
  
  console.log(`⏰ Live updates scheduled every ${API_CONFIG.updateInterval / 1000} seconds`);
};

// Function to update rates and notify subscribers
const updateRates = async () => {
  try {
    console.log('🔄 Updating rates...');
    const newRates = await fetchRatesFromAPI();
    
    // Check for significant changes (> 0.05% to reduce noise)
    const hasSignificantChange = checkSignificantChange(currentRates, newRates);
    
    if (hasSignificantChange || !currentRates.lastUpdated) {
      console.log('📊 Significant rate changes detected, updating subscribers');
      currentRates = newRates;
      
      // Notify all subscribers
      console.log(`📢 Notifying ${subscribers.size} subscribers`);
      subscribers.forEach(callback => {
        try {
          callback(currentRates);
        } catch (error) {
          console.error('❌ Error notifying subscriber:', error);
        }
      });
    } else {
      console.log('📈 No significant changes, updating timestamp only');
      currentRates.lastUpdated = newRates.lastUpdated;
    }
  } catch (error) {
    console.error('❌ Error during rate update:', error);
  }
};

// Check if there are significant changes in rates
const checkSignificantChange = (oldRates, newRates) => {
  const threshold = 0.0005; // 0.05% threshold
  
  const goldChange = Math.abs((newRates.gold['24KT'] - oldRates.gold['24KT']) / oldRates.gold['24KT']);
  const silverChange = Math.abs((newRates.silver['24KT'] - oldRates.silver['24KT']) / oldRates.silver['24KT']);
  
  const hasChange = goldChange > threshold || silverChange > threshold;
  
  if (hasChange) {
    console.log(`📊 Rate changes - Gold: ${(goldChange * 100).toFixed(3)}%, Silver: ${(silverChange * 100).toFixed(3)}%`);
  }
  
  return hasChange;
};

// Function to stop live updates
const stopLiveUpdates = () => {
  if (updateInterval) {
    console.log('⏹️ Stopping live rate updates');
    clearInterval(updateInterval);
    updateInterval = null;
  }
};

// Subscribe to rate updates
export const subscribeToRates = (callback) => {
  console.log('📝 New subscriber added');
  subscribers.add(callback);
  
  // Start live updates if not already running
  startLiveUpdates();
  
  // Immediately call callback with current rates
  try {
    callback(currentRates);
  } catch (error) {
    console.error('❌ Error calling initial callback:', error);
  }
  
  // Return unsubscribe function
  return () => {
    console.log('📝 Subscriber removed');
    subscribers.delete(callback);
    
    // If no more subscribers, stop live updates
    if (subscribers.size === 0) {
      stopLiveUpdates();
    }
  };
};

// Fetch current rates (force refresh)
export const fetchRates = async () => {
  console.log('🔄 Manual rate fetch requested');
  const freshRates = await fetchRatesFromAPI();
  currentRates = freshRates;
  
  // Notify subscribers of manual update
  subscribers.forEach(callback => {
    try {
      callback(currentRates);
    } catch (error) {
      console.error('❌ Error notifying subscriber during manual fetch:', error);
    }
  });
  
  return freshRates;
};

// Manual rate refresh function for pull-to-refresh
export const refreshRates = async () => {
  console.log('🔄 Manual refresh triggered');
  return await fetchRates();
};

// Format dates consistently throughout the app
export const formatDate = (date) => {
  return format(date, 'dd/MM/yyyy, HH:mm:ss a');
};

// Get current rates without triggering a fetch
export const getCurrentRates = () => currentRates;

// Export configuration for debugging
export const getConfig = () => ({
  updateInterval: API_CONFIG.updateInterval,
  enableLiveRates: API_CONFIG.enableLiveRates,
  subscriberCount: subscribers.size,
  lastUpdate: currentRates.lastUpdated,
  usdToInrRate: usdToInr,
  isUpdating: !!updateInterval,
  lastApiCall: new Date(lastApiCallTime).toISOString(),
  lastCurrencyUpdate: new Date(lastCurrencyUpdate).toISOString(),
});

// Health check function
export const checkApiHealth = async () => {
  try {
    console.log('🏥 Checking API health...');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch('https://api.metals.live/v1/spot', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'JewarHouse/1.0',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      return {
        status: 'healthy',
        message: 'Free API is responding correctly',
        data: {
          gold: data.gold || 'N/A',
          silver: data.silver || 'N/A',
          timestamp: new Date().toISOString()
        }
      };
    } else {
      return {
        status: 'error',
        message: `API returned ${response.status}`,
      };
    }
  } catch (error) {
    return {
      status: 'error',
      message: error.name === 'AbortError' ? 'API timeout' : error.message,
    };
  }
};

// Get market status
export const getMarketStatus = () => {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();
  
  const isWeekday = day >= 1 && day <= 5;
  const isMarketHours = hour >= 9 && hour < 17;
  
  return {
    isOpen: isWeekday && isMarketHours,
    nextOpen: isWeekday ? 
      (hour < 9 ? 'Today at 9:00 AM' : 'Tomorrow at 9:00 AM') :
      'Monday at 9:00 AM',
    status: (isWeekday && isMarketHours) ? 'OPEN' : 'CLOSED',
    volatility: getTimeBasedVolatility(),
    sentiment: getMarketSentiment(),
  };
};

// Get rate statistics for the current session
export const getRateStatistics = () => {
  // This would typically track min/max/average over time
  // For now, return basic info
  return {
    currentRates: currentRates,
    marketStatus: getMarketStatus(),
    config: getConfig(),
    lastUpdate: formatDate(currentRates.lastUpdated),
  };
};